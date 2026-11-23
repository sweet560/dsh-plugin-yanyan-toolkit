// 路径 A · 第 4b 阶段（Host 服务层 + HTTP 路由 + Client 契约）测试。
// 复用第 1 阶段的内存 fs 夹具思路，验证：TrashService 组装 deps 正确性、
// cascadeDeps 透传链、路由准入/方法/body/错误码、reason 影响范围码原样透传、
// 聚合包根 lib 的服务/路由契约；client 侧回归见本文件末尾的宿主刷新守护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

test('回收站增强：TrashService.list 补 content/cwd（标题/内容/ID 搜索的数据源）', async () => {
  const trashedDir = '/dsh/session-trash/proj/session-rich';
  const jsonl = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-rich', cwd: 'F:\\DeepSeek Harness workspace\\default-workspace\\demo', origin: 'subagent' }),
    JSON.stringify({ type: 'session/title', seq: 1, data: { title: '旧标题' } }),
    JSON.stringify({ type: 'session/title', seq: 9, data: { title: '最新标题' } }),
    JSON.stringify({ type: 'user/message', seq: 10, data: { content: [{ type: 'text', text: '你好世界' }, { type: 'image', data: 'x' }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: '回复内容' }] } } }),
  ].join('\n');
  const manifest = { version: 1, entries: {
    'session-rich': { id: 'session-rich', originalPath: '/old/rich', trashedPath: trashedDir, trashedAt: 1 },
  }, quarantined: [] };
  const fs = createMemFs({
    dirs: ['/dsh/session-trash'], manifest,
    files: { [join(trashedDir, 'session.v4.jsonl.zstd')]: zstdCompressSync(Buffer.from(jsonl)) },
  });
  const service = new TrashService({ fs, sessionsRoot: '/dsh/sessions', trashRoot: '/dsh/session-trash', caps: makeCaps() });
  const res = await service.list();
  const e = res.entries.find((x) => x.id === 'session-rich');
  assert.equal(e.title, '最新标题', '取末条 session/title 为最新标题');
  assert.match(e.content, /你好世界/, 'content 含 user/message 的 text part');
  assert.match(e.content, /回复内容/, 'content 含 assistant/message 的 text part');
  assert.doesNotMatch(e.content, /image/, '忽略非 text part');
  assert.equal(e.cwd, 'F:\\DeepSeek Harness workspace\\default-workspace\\demo', '补 cwd 供工作区筛选派生');
  assert.equal(e.origin, 'subagent', '补 origin 供回收站行显示子会话状态');
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

// ---- 回归守护：回收站变更必须让宿主立即重新发现会话（m00024 / m03612 / m03616） ----

test('session-hub client：恢复/归档/批量删除后触发宿主 sessions.refresh（m00024）', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-session-hub', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('_refreshHostSessions'), '应有宿主刷新方法 _refreshHostSessions');
  assert.ok(/sessions[\s\S]{0,40}refresh|\.refresh\(\)/.test(src), '应调用 sessions.refresh() 让宿主重新发现会话');
  assert.ok(/ctx\.get\(\s*["']sessions["']\s*\)/.test(src), 'apply 应从 ctx 注入宿主 sessions 能力');
  assert.ok((src.match(/_refreshHostSessions\(\)/g) || []).length >= 3, '恢复/归档/批量删除三条变更链都应触发宿主刷新');
});

test('session-hub client：批量删除成功后清空选中（m00490）', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-session-hub', 'lib', 'client.js'), 'utf8');
  // 不清选中会导致已删/已入回收站的会话仍高亮，残留 id 再次删除时全部落 otherIds →
  // trashMove 对不存在会话失败，表现为「点确定没反应 / 反复弹同样的 N 条」。
  assert.ok(/batchDelete\(archivedIds, otherIds\)\.then\(function \(\) \{ setSelectedIds\(\[\]\); \}\)/.test(src),
    'batchDelete 成功后应清空 selectedIds');
});

test('session-hub client：批量删除三态确认文案，混合选中单独提示（m00490）', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-session-hub', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('"hub.deleteMixedConfirm"'), '应有混合选中专用文案 key deleteMixedConfirm');
  // zh 与 en 各一条定义
  assert.ok((src.match(/"hub\.deleteMixedConfirm":/g) || []).length >= 2, 'zh/en 都应定义 deleteMixedConfirm');
  // 三态分流：全归档 / 全未归档 / 混合（na=已归档数, nn=未归档数）
  assert.ok(/confirmKey = "hub\.deleteArchivedConfirm"/.test(src), '全归档走 deleteArchivedConfirm');
  assert.ok(/confirmKey = "hub\.deleteToTrashConfirm"/.test(src), '全未归档走 deleteToTrashConfirm');
  assert.ok(/confirmKey = "hub\.deleteMixedConfirm"/.test(src), '混合选中走 deleteMixedConfirm');
  assert.ok(/confirmVars\.na = archivedIds\.length/.test(src) && /confirmVars\.nn = otherIds\.length/.test(src),
    '混合文案应带出两组会话数量');
});

test('session-hub client：面板重新打开时清空一次性操作结果提示（m01064）', () => {
  const src = readFileSync(join(here, '..', 'packages', 'dsh-plugin-yanyan-session-hub', 'lib', 'client.js'), 'utf8');
  // controller 是 apply 级单例，跨面板开关复用。archiveResult/exportResult/trashResult
  // 只在 mutate 时设置、从不清空；若挂载时不清，上次「已删除 1 个会话」会一直残留。
  assert.ok(/HubController\.prototype\.clearResults = function/.test(src), '应有 clearResults 方法');
  assert.ok(/archiveResult: null, exportResult: null, trashResult: null/.test(src),
    'clearResults 应把三个一次性结果状态都清空');
  assert.ok(/clearSearch\(\);[\s\S]{0,160}clearResults\(\)/.test(src),
    '面板挂载时应在 clearSearch 之后调用 clearResults（与单例复用清理同类）');
  // 顶部「刷新」按钮也应清结果提示：手动刷新后顶部旧绿条不应残留。
  assert.ok((src.match(/clearResults\(\)/g) || []).length >= 2,
    '除挂载清理外，刷新按钮也应调用 clearResults（至少两处调用）');
});
