// 路径 A · 第 4b 阶段（Host 服务层 + HTTP 路由 + Client 契约）测试。
// 复用第 1 阶段的内存 fs 夹具思路，验证：TrashService 组装 deps 正确性、
// cascadeDeps 透传链、路由准入/方法/body/错误码、reason 影响范围码原样透传、
// client 源码的 settings.section / reason 映射 / 双入口标注 / 事件订阅契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

import { descendantsOf } from '../lib/session-cascade.js';

import {
  rootsFor,
  makeServiceFs,
  capabilitiesFromContext,
  TrashService,
  createTrashService,
  TRASH_API_PREFIX,
  REMOVED_EVENT,
  ADDED_EVENT,
  PURGED_EVENT,
} from '../lib/session-trash-service.js';
import {
  TRASH_ROUTE_PREFIX,
  TRASH_ROUTE_PATHS,
  makeTrashHandler,
  makeTrashRoutes,
} from '../lib/session-trash-routes.js';

const here = dirname(fileURLToPath(import.meta.url));

// ---- 内存 fs 夹具 ----
function createMemFs({ dirs = [], manifest, files = {} } = {}) {
  const dirSet = new Set();
  const add = (d) => {
    let cur = resolve(d);
    for (;;) {
      dirSet.add(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  dirs.forEach(add);
  const fileSet = new Set();
  const contents = {};
  for (const [p, data] of Object.entries(files)) { contents[resolve(p)] = data; fileSet.add(resolve(p)); }
  const fs = {
    lstat: (p) => ({ isSymbolicLink: () => false, isDirectory: () => dirSet.has(resolve(p)) }),
    realpath: (p) => resolve(p),
    stat: () => ({ dev: 1 }),
    rename: () => {},
    mkdir: (p) => add(p),
    readFile: (p) => contents[resolve(p)] ?? (resolve(p).endsWith('manifest.json') && manifest !== undefined ? JSON.stringify(manifest) : undefined),
    writeFile: (p, data) => { fileSet.add(resolve(p)); contents[resolve(p)] = data; },
    readdir: (p) => {
      const ap = resolve(p);
      const out = new Set();
      for (const d of dirSet) if (dirname(d) === ap) out.add(d.split(/[\\/]/).pop());
      return [...out];
    },
    exists: (p) => dirSet.has(resolve(p)) || fileSet.has(resolve(p)) || (String(p).endsWith('manifest.json') && manifest !== undefined),
    rm: () => {},
    __dirSet: dirSet,
  };
  return fs;
}

function makeCaps(overrides = {}) {
  return {
    archiveSession: overrides.archiveSession || (async () => {}),
    unarchiveSession: overrides.unarchiveSession || (async () => {}),
    emitRemoved: overrides.emitRemoved || (() => {}),
    emitAdded: overrides.emitAdded || (() => {}),
    emitPurged: overrides.emitPurged || (() => {}),
    runningOf: overrides.runningOf || (() => false),
    protectedReasonOf: overrides.protectedReasonOf || (() => undefined),
  };
}

// ---- 常量与工厂 ----

test('TRASH_API_PREFIX 与事件名常量正确（事件名与宿主原生一致）', () => {
  assert.equal(TRASH_API_PREFIX, '/api/dsh-yanyan-trash');
  assert.equal(TRASH_ROUTE_PREFIX, TRASH_API_PREFIX);
  assert.equal(REMOVED_EVENT, 'api-session/removed');
  assert.equal(ADDED_EVENT, 'api-session/added');
  assert.equal(PURGED_EVENT, 'api-session/purged');
});

test('rootsFor 派生 sessions/trash 两个根目录', () => {
  const r = rootsFor('/dsh-home');
  assert.equal(r.sessionsRoot, join('/dsh-home', 'sessions'));
  assert.equal(r.trashRoot, join('/dsh-home', 'session-trash'));
});

test('makeServiceFs 带 rm 与两个 root 字段，且无重复造轮子', () => {
  const base = { readFile: () => {}, writeFile: () => {}, lstat: () => {}, realpath: () => {}, stat: () => {}, rename: () => {}, mkdir: () => {}, readdir: () => {}, exists: () => {} };
  const fs = makeServiceFs('/s', '/t', base);
  assert.equal(fs.__sessionsRoot, '/s');
  assert.equal(fs.__trashRoot, '/t');
  assert.equal(typeof fs.rm, 'function');
});

test('capabilitiesFromContext 能力探测：缺失返回 null，emit 绑定 ctx', () => {
  const emitted = [];
  const ctx = {
    workspaceRegistry: { archiveSession: async () => {}, unarchiveSession: async () => {} },
    emit: (...a) => emitted.push(a),
    get: () => ({ list: () => [] }),
  };
  const caps = capabilitiesFromContext(ctx);
  assert.equal(typeof caps.archiveSession, 'function');
  assert.equal(typeof caps.unarchiveSession, 'function');
  caps.emitRemoved('session-x');
  assert.deepEqual(emitted[0], [REMOVED_EVENT, 'session-x']);

  const bare = capabilitiesFromContext({});
  assert.equal(bare.archiveSession, null);
  assert.equal(bare.unarchiveSession, null);
  assert.equal(bare.emitRemoved, null);
});

test('真机 bug m03612/m03616：emitAdded 恒为 null，绝不伪造宿主 api-session/added', () => {
  // 宿主 added payload 是 summaryFor 对象（字段 sessionId/title），发字符串 id 会造出
  // "未命名/NaN/id=undefined"幽灵会话。修复后 emitAdded 必须是 null（no-op），
  // UI 刷新改由 client 的 sessions.refresh() 承担。
  const emitted = [];
  const ctx = {
    workspaceRegistry: { archiveSession: async () => {}, unarchiveSession: async () => {} },
    emit: (...a) => emitted.push(a),
    get: () => ({ list: () => [] }),
  };
  const caps = capabilitiesFromContext(ctx);
  assert.equal(caps.emitAdded, null, 'emitAdded 必须为 null，不得伪造 added 事件');
  // removed/purged 仍保留（字符串 id，与宿主 disposed schema 匹配）
  assert.equal(typeof caps.emitRemoved, 'function');
  assert.equal(typeof caps.emitPurged, 'function');
  caps.emitRemoved('session-x');
  assert.deepEqual(emitted, [[REMOVED_EVENT, 'session-x']], '只允许 removed 广播');
});

test('capabilitiesFromContext 读态异常 throw（fail-safe，read-error 保护纪律）', () => {
  // agents.get 抛错时 runningOf 必须 fail-safe throw（真机 bug m03443 修复后断言目标改为 agents）
  const ctx = {
    get: (name) => name === 'agents'
      ? { get: () => { throw new Error('boom'); } }
      : { list: () => [] },
  };
  const caps = capabilitiesFromContext(ctx);
  assert.throws(() => caps.runningOf('session-x'), /agent status read failed/);
});

test('真机 bug m03443：空闲会话（attached 但 agent status=idle）不算 running，可删除', () => {
  // 空闲会话仍在 sessions.list()（attached）但 agent.status !== 'running'；
  // 旧实现 runningOf=isLive 会误判 running 而拒绝 move —— 这正是真机报错根因。
  const ctx = {
    workspaceRegistry: {},
    get: (name) => {
      if (name === 'agents') {
        return { get: (id) => ({ status: 'idle', id }) };
      }
      // sessions.list() 含该会话 → attached
      return { list: () => [{ id: 'session-21ccdd5d-e762-40e8-bb65-828b093df2c4' }] };
    },
  };
  const caps = capabilitiesFromContext(ctx);
  assert.equal(caps.runningOf('session-21ccdd5d-e762-40e8-bb65-828b093df2c4'), false);
  // attached 语义保留：protectedReasonOf 仍认为它在 live store
  assert.equal(caps.protectedReasonOf('session-21ccdd5d-e762-40e8-bb65-828b093df2c4'), 'attached');
});

test('runningOf：agent.status==="running" 才为真（真运行态，独立于 attached）', () => {
  const ctx = {
    get: (name) => name === 'agents'
      ? { get: (id) => ({ status: id === 'session-live' ? 'running' : 'idle' }) }
      : { list: () => [] },
  };
  const caps = capabilitiesFromContext(ctx);
  assert.equal(caps.runningOf('session-live'), true);
  assert.equal(caps.runningOf('session-idle'), false);
});

test('runningOf：agents 服务缺失时返回 false（不误伤删除），不抛', () => {
  const ctx = { get: () => undefined };
  const caps = capabilitiesFromContext(ctx);
  assert.equal(caps.runningOf('session-x'), false);
});

// ---- TrashService 方法组装 ----

test('TrashService.list 返回 manifest 条目（ok + count）', async () => {
  const manifest = { version: 1, entries: { 'session-a': { id: 'session-a', originalPath: '/old/a', trashedAt: 1 } }, quarantined: [] };
  const fs = createMemFs({ dirs: ['/dsh/session-trash'], manifest });
  const service = new TrashService({
    fs, sessionsRoot: '/dsh/sessions', trashRoot: '/dsh/session-trash', caps: makeCaps(),
  });
  const res = await service.list();
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.ok(Array.isArray(res.entries));
  assert.equal(res.entries.find((e) => e.id === 'session-a').id, 'session-a');
});

test('真机 bug m03612：TrashService.list 从会话日志补 entry.title，读不到回退 null', async () => {
  const trashedDir = '/dsh/session-trash/proj/session-titled';
  const jsonl = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-titled' }),
    JSON.stringify({ type: 'session/title', seq: 9, data: { title: 'Numeric Input' } }),
  ].join('\n');
  const manifest = { version: 1, entries: {
    'session-titled': { id: 'session-titled', originalPath: '/old/a', trashedPath: trashedDir, trashedAt: 1 },
    'session-plain': { id: 'session-plain', originalPath: '/old/b', trashedPath: '/dsh/session-trash/proj/session-plain', trashedAt: 2 },
  }, quarantined: [] };
  const fs = createMemFs({
    dirs: ['/dsh/session-trash'], manifest,
    files: { [join(trashedDir, 'session.v4.jsonl.zstd')]: zstdCompressSync(Buffer.from(jsonl)) },
  });
  const service = new TrashService({ fs, sessionsRoot: '/dsh/sessions', trashRoot: '/dsh/session-trash', caps: makeCaps() });
  const res = await service.list();
  assert.equal(res.ok, true);
  const titled = res.entries.find((e) => e.id === 'session-titled');
  const plain = res.entries.find((e) => e.id === 'session-plain');
  assert.equal(titled.title, 'Numeric Input', '应从日志 session/title 补标题');
  assert.equal(plain.title, null, '读不到日志回退 null，由 client 显示 id');
});

test('TrashService.baseDeps 透传 locate/isSessionActive，能力齐全', () => {
  const caps = makeCaps();
  const service = new TrashService({ fs: createMemFs(), sessionsRoot: '/s', trashRoot: '/t', caps });
  const deps = service.baseDeps();
  assert.equal(typeof deps.locate, 'function');
  assert.equal(typeof deps.isSessionActive, 'function');
  assert.equal(deps.archiveSession, caps.archiveSession);
  assert.equal(deps.unarchiveSession, caps.unarchiveSession);
  assert.equal(deps.emitRemoved, caps.emitRemoved);
});

test('TrashService.cascadePurge 提供 cascadeDeps.purgeDeps（逐行核实透传链）', async () => {
  const calls = [];
  // 注入 cascadePurgeFromTrash 的去向无法直接拿到，但可通过 snapshot 阶段失败短路来验证
  // cascade 被真正调用：manifest 空 + ids 不在快照 → 整批拒绝，reason 透传。
  const fs = createMemFs({ dirs: ['/dsh/session-trash'], manifest: { version: 1, entries: {}, quarantined: [] } });
  const service = new TrashService({ fs, sessionsRoot: '/s', trashRoot: '/t', caps: makeCaps() });
  const res = await service.cascadePurge(['session-missing']);
  assert.equal(res.ok, false);
  // 快照构建失败应整批拒绝、不得抛出（说明 cascadeDeps 结构正确，未缺键崩溃）
  assert.ok(res.reasons || res.reason || res.failed);
});

test('createTrashService 用默认 DSH_HOME 派生 roots', () => {
  const ctx = { connection: {}, get: () => undefined };
  const service = createTrashService(ctx, { dshHome: '/my-dsh' });
  assert.equal(service.trashRoot, join('/my-dsh', 'session-trash'));
  assert.equal(typeof service.list, 'function');
});

// ---- 路由层 ----

function fakeRes() {
  return {
    status: 0, head: null, body: null,
    writeHead(status, head) { this.status = status; this.head = head; },
    end(payload) { this.body = typeof payload === 'string' ? JSON.parse(payload) : payload; },
  };
}
function fakeReq(method, bodyObj) {
  const req = { method };
  if (bodyObj !== undefined) {
    const payload = JSON.stringify(bodyObj);
    let sent = false;
    req.on = (evt, fn) => {
      if (evt === 'data' && !sent) { sent = true; fn(Buffer.from(payload)); }
      if (evt === 'end') queueMicrotask(() => fn());
    };
  }
  return req;
}
const allow = () => true;
const deny = () => false;

test('makeTrashHandler：准入拒绝 403、错误方法 405', async () => {
  let res = fakeRes();
  await makeTrashHandler(deny, 'POST', async () => ({ ok: true }))(fakeReq('POST', {}), res);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden');

  res = fakeRes();
  await makeTrashHandler(allow, 'POST', async () => ({ ok: true }))(fakeReq('GET'), res);
  assert.equal(res.status, 405);
  assert.equal(res.body.error, 'method-not-allowed');
});

test('makeTrashHandler：POST body 解析与 result 原样序列化（ok/reason 码透传）', async () => {
  const result = { ok: false, primaryOk: false, descendantsOk: false, results: [{ id: 'session-a', reason: 'read-error' }] };
  let seen;
  const res = fakeRes();
  await makeTrashHandler(allow, 'POST', async (body) => { seen = body; return result; })(
    fakeReq('POST', { ids: ['session-a'], protectedReason: {} }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(seen.ids, ['session-a']);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.results[0].reason, 'read-error'); // 影响范围码原样透传
  assert.equal(res.head['cache-control'], 'no-store');
});

test('makeTrashHandler：坏 JSON 400、超大 body 413', async () => {
  let res = fakeRes();
  const bad = { method: 'POST', on: (evt, fn) => { if (evt === 'data') fn(Buffer.from('{bad')); if (evt === 'end') queueMicrotask(() => fn()); } };
  await makeTrashHandler(allow, 'POST', async () => ({ ok: true }))(bad, res);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'bad-json');

  res = fakeRes();
  const big = { method: 'POST', on: (evt, fn) => { if (evt === 'data') fn(Buffer.alloc(1_000_001, 'x')); if (evt === 'end') queueMicrotask(() => fn()); } };
  await makeTrashHandler(allow, 'POST', async () => ({ ok: true }))(big, res);
  assert.equal(res.status, 413);
  assert.equal(res.body.error, 'payload-too-large');
});

test('makeTrashRoutes：8 条路由齐全，读写方法正确，路径与前缀一致', () => {
  const service = { list: async () => ({}), snapshot: async () => ({}), restore: async () => ({}), trash: async () => ({}), purge: async () => ({}), cascadePurge: async () => ({}), purgeExpired: async () => ({}), recoverPurging: async () => ({}) };
  const routes = makeTrashRoutes(service, { connection: { requestRejection: () => undefined } });
  assert.equal(routes.length, 8);
  const byPath = new Map(routes.map((r) => [r.path, r.method]));
  assert.equal(byPath.get(TRASH_ROUTE_PATHS.list), 'GET');
  assert.equal(byPath.get(TRASH_ROUTE_PATHS.snapshot), 'GET');
  for (const key of ['restore', 'trash', 'purge', 'cascade', 'purgeExpired', 'recover']) {
    assert.equal(byPath.get(TRASH_ROUTE_PATHS[key]), 'POST', `${key} 应为 POST`);
  }
  for (const r of routes) assert.ok(r.path.startsWith(TRASH_API_PREFIX));
});

test('makeTrashRoutes：restore 路由把 id 传给 service.restore', async () => {
  let got;
  const service = { restore: async (id) => { got = id; return { ok: true }; } };
  const routes = makeTrashRoutes(service, { connection: { requestRejection: () => undefined } });
  const restoreRoute = routes.find((r) => r.path === TRASH_ROUTE_PATHS.restore);
  const res = fakeRes();
  await restoreRoute.handler(fakeReq('POST', { id: 'session-xyz' }), res);
  assert.equal(got, 'session-xyz');
  assert.equal(res.body.ok, true);
});

// ---- 子包 host 入口可加载 + 注入声明 ----

test('新子包 host 入口可 import，name/inject/apply 契约正确', async () => {
  const mod = await import('../packages/dsh-plugin-yanyan-trash/lib/index.js');
  assert.equal(mod.name, 'dsh-plugin-yanyan-trash');
  assert.equal(typeof mod.apply, 'function');
  assert.ok(mod.inject.includes('webServer'));
  assert.ok(mod.inject.includes('workspaceRegistry'));
});

// ---- Client 契约（源码断言，无 DOM 环境） ----

test('client 源码：react 由 require 注入、settings.section 用独立 id/order', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('__ModuleLoader__'));
  assert.ok(src.includes('require("react")'));
  assert.ok(src.includes('ctx.slots.register'));
  assert.ok(src.includes('"settings.section"'));
  assert.ok(src.includes('"dsh-yanyan-trash"'), '独立 section id 防重');
  assert.ok(src.includes('api/dsh-yanyan-trash'), '消费 host 路由前缀');
});

test('client 源码：reason 映射含影响范围粒度（item/family/batch）与 read-error 家族提示', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'client.js'), 'utf8');
  for (const code of ['corrupt-target', 'read-error', 'family-protected', 'child-ids-dangling', 'purge-in-progress']) {
    assert.ok(src.includes('"' + code + '"'), `缺少 reason 映射 ${code}`);
  }
  assert.ok(src.includes('scope: "item"'));
  assert.ok(src.includes('scope: "family"'));
  assert.ok(src.includes('scope: "batch"'));
  assert.ok(/连同其子代理一并保留|subagents were all kept/.test(src), 'read-error 家族整族保留提示');
});

test('client 源码：双入口过渡标注 + 原生事件订阅 + canonical id 直接消费', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'client.js'), 'utf8');
  assert.ok(/不进入回收站|does NOT enter this trash/.test(src), '双入口过渡标注');
  assert.ok(src.includes('api-session/removed'));
  assert.ok(src.includes('api-session/added'));
  // 真机 bug m03612/m03616：恢复/删除成功后必须让宿主自行刷新会话（照抄现成包 sessions.refresh）。
  assert.ok(src.includes('_refreshHostSessions'), '应有宿主刷新方法 _refreshHostSessions');
  assert.ok(/sessions[\s\S]{0,40}refresh|\.refresh\(\)/.test(src), '应调用 sessions.refresh() 让宿主重新发现会话');
  // payload 已是 canonical 字符串：client 不再调用 canonicalSessionId/replace 归一
  assert.ok(!/canonicalSessionId\(/.test(src), 'client 不应自行归一 id');
});

test('client 源码：级联删除有确认预览（只沿 origin=subagent 计数，fork 剪掉）', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('countCascadeDescendants'), '应有级联后代计数函数');
  assert.ok(src.includes('child.origin !== "subagent"'), '预览应只沿 origin=subagent，剪掉 fork');
  assert.ok(src.includes('"trash.confirmCascade"'), '应有确认文案（含 {n}）');
  assert.ok(src.includes('"data-dsh-part": "confirm"'), '应有确认对话框 UI');
  assert.ok(src.includes('setPending({ kind: "cascade"'), '级联按钮应弹确认而非直接删');
  assert.ok(src.includes('setPending({ kind: "batchPurge"'), '批量彻底删除应弹确认');
});

test('client 源码：空状态含「其他入口删除的会话不在此处」提示', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'client.js'), 'utf8');
  assert.ok(/其他入口删除的会话不会出现在此处|deleted through other entries do not appear here/.test(src), '双入口空状态提示');
});

// ---- P1-b：client 级联预览与 host descendantsOf 的等价性锁死 ----

/** 在 Node 中通过 vm 执行 client IIFE，拿其 __testing 纯函数钩子。 */
function loadClientTesting() {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'client.js'), 'utf8');
  let captured = null;
  const fakeReact = {
    createElement: () => ({}),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => null,
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          // 只取 factory，不执行 apply（apply 需要 slots/locale/connection 等 ctx）。
          const module = entry.factory((name) => {
            if (name === 'react') return fakeReact;
            return {};
          });
          captured = module.__testing;
        },
      },
    },
    fetch: () => Promise.resolve({}),
    // client 的 __testing 钩子由 typeof process !== 'undefined' 守卫，
    // 浏览器不暴露；测试沙箱注入 process 以模拟 Node 环境拿到同一份 factory 导出的函数。
    process: {},
    Promise,
    Set,
    Object,
    String,
    Array,
    Date,
    console,
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-plugin-yanyan-trash/client.js' });
  return captured;
}

test('P1-b：client collectCascadeDescendants 与 host descendantsOf 等价（subagent/fork/嵌套/环）', () => {
  const t = loadClientTesting();
  assert.ok(t && typeof t.collectCascadeDescendants === 'function', 'client 应暴露 __testing.collectCascadeDescendants');
  const row = (id, origin, childIds) => ({ id, origin, childIds });
  // 覆盖：多层 subagent 链、fork 分支（应剪掉）、环、共享子代理、未知 origin。
  const rows = [
    row('root', undefined, ['a', 'f']),
    row('a', 'subagent', ['b', 'shared']),
    row('b', 'subagent', ['a']),          // 环：b -> a
    row('f', 'fork', ['forkchild']),        // fork 整条分支剪掉
    row('forkchild', 'subagent', []),
    row('shared', 'subagent', []),
    row('other', undefined, ['shared']),    // 另一个父共享 shared
    row('weird', 'pinned', []),             // 未知 origin 剪掉
  ];
  for (const id of ['root', 'a', 'b', 'f', 'other']) {
    const host = new Set(descendantsOf(rows, id));
    const client = new Set(t.collectCascadeDescendants(rows, id));
    assert.deepEqual([...client].sort(), [...host].sort(), `后代集合应等价：root=${id}`);
  }
});

test('P1-b：批量预览 N 对共享子代理去重（与 cascade targets Set 一致）', () => {
  const t = loadClientTesting();
  const row = (id, origin, childIds) => ({ id, origin, childIds });
  const rows = [
    row('p1', undefined, ['shared', 'c1']),
    row('p2', undefined, ['shared', 'c2']),
    row('shared', 'subagent', []),
    row('c1', 'subagent', []),
    row('c2', 'subagent', []),
  ];
  // 逐个求和会得 4（shared 被计两次），并集去重应为 3。
  const union = {};
  ['p1', 'p2'].forEach((id) => t.collectCascadeDescendants(rows, id).forEach((c) => { union[c] = true; }));
  assert.equal(Object.keys(union).length, 3, '共享子代理应去重');
});

test('P1-c：reasonText 对未映射 reason 回退通用文案（非空白/undefined）', () => {
  const t = loadClientTesting();
  const out = t.reasonText({ reason: 'pinned-protection-future' });
  assert.ok(out.text && out.text.length > 0, '未知 reason 应有回退文案');
  assert.ok(/pinned-protection-future/.test(out.text), '回退文案应保留原始 reason 代码便于诊断');
  assert.equal(out.scope, 'item');
});

test('archive-gate / archive-active 有映射文案，不向用户暴露原始代码（m05087）', () => {
  const t = loadClientTesting();
  for (const code of ['archive-gate', 'archive-active']) {
    assert.ok(t.REASON_MAP[code], `${code} 应在 REASON_MAP 中`);
    const out = t.reasonText({ reason: code });
    assert.ok(out.text && out.text.length > 0, `${code} 应有提示文案`);
    assert.ok(!/archive-/.test(out.text), `${code} 文案不应暴露原始 reason 代码`);
    assert.equal(out.scope, 'item');
    // 文案应命中映射的中/英之一，而非 reasonUnknown 回退（回退会含原始代码，已被上一条断言排除）
    const mapped = t.REASON_MAP[code];
    assert.ok(out.text === mapped.zh || out.text === mapped.en, `${code} 应显示映射文案`);
  }
});

// ---- UI 重构：标题回退 / 搜索过滤 / 时间格式化 / CSS 注入契约 ----

test('UI 重构：displayTitle 多级回退，绝不显示裸 id/undefined/NaN', () => {
  const t = loadClientTesting();
  assert.equal(typeof t.displayTitle, 'function', '应暴露 __testing.displayTitle');
  assert.equal(t.displayTitle({ title: '  Numeric Input  ' }), 'Numeric Input', 'title 优先且 trim');
  assert.equal(t.displayTitle({ title: '', displayTitle: '备用标题' }), '备用标题', 'title 空则回退 displayTitle');
  assert.equal(t.displayTitle({ label: '标签' }), '标签', '回退 label');
  assert.equal(t.displayTitle({ sessionTitle: '会话标题' }), '会话标题', '回退 sessionTitle');
  assert.equal(t.displayTitle({ title: undefined }), null, '无标题返回 null 交由调用方回退短 id');
  assert.equal(t.displayTitle(null), null);
  assert.equal(t.displayTitle({ title: '   ' }), null, '纯空白视为无标题');
});

test('UI 重构：shortId 去前缀取前 8 位，formatActivityTime 多字段回退', () => {
  const t = loadClientTesting();
  assert.equal(t.shortId('session-abcdef123456'), 'abcdef12', '去 session- 前缀取前 8 位');
  assert.equal(t.shortId('mnemon-run-v1-xyz'), 'mnemon-r', '非 session 前缀直接取前 8 位');
  assert.equal(t.shortId(''), '');
  const t1 = t.formatActivityTime({ lastActivityAt: 1700000000000 });
  assert.ok(t1 && t1.length > 0, 'lastActivityAt 应格式化');
  assert.ok(t.formatActivityTime({ updatedAt: 1700000000000 }), '回退 updatedAt');
  assert.ok(t.formatActivityTime({ createdAt: 1700000000000 }), '回退 createdAt');
  assert.equal(t.formatActivityTime({ lastActivityAt: NaN }), null, 'NaN 不应显示');
  assert.equal(t.formatActivityTime({}), null, '无时间返回 null');
});

test('UI 重构：filterLiveRows 按标题或 id 实时过滤（大小写不敏感）', () => {
  const t = loadClientTesting();
  const rows = [
    { id: 'session-aaa11111', title: 'Numeric Input' },
    { id: 'session-bbb22222', label: '研研工具' },
    { id: 'session-ccc33333' },
  ];
  assert.equal(t.filterLiveRows(rows, '').length, 3, '空查询返回全部');
  assert.deepEqual(t.filterLiveRows(rows, 'numeric').map((r) => r.id), ['session-aaa11111'], '按标题过滤');
  assert.deepEqual(t.filterLiveRows(rows, '研研').map((r) => r.id), ['session-bbb22222'], '按 label 过滤');
  assert.deepEqual(t.filterLiveRows(rows, 'BBB').map((r) => r.id), ['session-bbb22222'], '按 id 大小写不敏感');
  assert.equal(t.filterLiveRows(rows, '不存在').length, 0);
});

test('UI 重构：CSS 用 --dsw-alias token 注入、tagId 防重；列表/搜索/多选结构齐备', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('--dsw-alias-'), 'CSS 应走 DSH 原生视觉 token');
  assert.ok(src.includes('data-plugin-css'), 'CSS 注入应带防重标记');
  assert.ok(src.includes('injectCss()'), 'apply 应调用 injectCss');
  assert.ok(src.includes('type: "search"'), '应有搜索框');
  assert.ok(/data-dsh-part": "active-section"/.test(src), '应有上半区活跃会话区块');
  assert.ok(/data-dsh-part": "trash-section"/.test(src), '应有下半区回收站区块');
  assert.ok(/data-dsh-part": "live-row"/.test(src), '活跃会话应用列表行而非 select');
  assert.ok(src.includes('trashMany'), '应支持批量移入回收站');
  assert.ok(src.includes('displayTitle(row)'), '列表行应显示标题回退');
  assert.ok(src.includes('formatActivityTime(row)'), '列表行应显示最后活跃时间');
  // 核心逻辑不被破坏：仍消费 host 路由、事件订阅、宿主刷新。
  assert.ok(src.includes('api/dsh-yanyan-trash'));
  assert.ok(src.includes('_refreshHostSessions'));
  assert.ok(!/canonicalSessionId\(/.test(src), 'client 不应自行归一 id');
});

// ---- 静态守护：Host 模块不复制逻辑、子包不改现成包 ----

test('子包 host 不自己 import node:fs 的 rmSync，复用聚合包 makeServiceFs', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-trash', 'lib', 'index.js'), 'utf8');
  assert.ok(src.includes('session-trash-service.js'));
  assert.ok(src.includes('session-trash-routes.js'));
  assert.ok(!/import\s*\{[^}]*\brmSync\b/.test(src), '子包 host 不应自行引入 rmSync');
});
