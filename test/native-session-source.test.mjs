// 原生会话数据源测试：归档事实源降级 / 归档时间台账 / 状态标签映射。
// 全部 fail-closed，只读，不碰真实文件系统（内存 fs 注入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readArchivedIds, readArchiveLedger, statusLabels, readSessionIndexIds, readSessionDirSizes, readFeedStatuses } from '../lib/native-session-source.js';

function memFs(files = {}) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p)
      || Object.keys(files).some((f) => f.startsWith(p + '/') || f.startsWith(p + '\\')),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT ' + p);
      return files[p];
    },
    readdirSync: (p) => {
      const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
      const prefix = norm(p) + '/';
      const names = new Set();
      for (const f of Object.keys(files)) {
        const nf = norm(f);
        if (nf.startsWith(prefix)) {
          const rest = nf.slice(prefix.length);
          if (rest && !rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

test('readArchivedIds 优先用内存 registry.archivedSessionIds', () => {
  const fs = memFs({
    [join('/home', 'storages', 'workspace.json')]: JSON.stringify({ global: { archivedSessionIds: ['session-from-file'] } }),
  });
  const res = readArchivedIds(fs, '/home', { archivedSessionIds: ['session-a', 'session-b'] });
  assert.equal(res.source, 'registry');
  assert.deepEqual([...res.ids].sort(), ['session-a', 'session-b']);
});

test('readArchivedIds 无 registry 时降级读 workspace.json', () => {
  const fs = memFs({
    [join('/home', 'storages', 'workspace.json')]: JSON.stringify({ global: { archivedSessionIds: ['session-from-file', 42, null] } }),
  });
  const res = readArchivedIds(fs, '/home', null);
  assert.equal(res.source, 'workspace');
  assert.deepEqual([...res.ids], ['session-from-file']);
});

test('readArchivedIds 全都读不到时返回空集合（fail-closed）', () => {
  const res = readArchivedIds(memFs({}), '/home', null);
  assert.equal(res.source, 'none');
  assert.equal(res.ids.size, 0);
});

test('readArchiveLedger 读 entries[id].archivedAt（epoch ms）+ source', () => {
  const fs = memFs({
    [join('/home', 'dsh-session-archive', 'archive-ledger.json')]: JSON.stringify({
      version: 1,
      entries: {
        'session-a': { archivedAt: 1794716215920, source: 'manual' },
        'session-b': { archivedAt: 1794716215999, source: 'observed' },
        'session-bad': { archivedAt: 'not-a-number' },
      },
    }),
  });
  const m = readArchiveLedger(fs, '/home');
  assert.equal(m.get('session-a').archivedAt, 1794716215920);
  assert.equal(m.get('session-a').source, 'manual');
  assert.equal(m.get('session-b').source, 'observed');
  assert.equal(m.has('session-bad'), false);
});

test('readArchiveLedger 文件损坏时返回空 Map（fail-closed）', () => {
  const fs = memFs({ [join('/home', 'dsh-session-archive', 'archive-ledger.json')]: '{bad json' });
  assert.equal(readArchiveLedger(fs, '/home').size, 0);
});

test('statusLabels 按 running/blank/archived/origin 映射，缺省为「空闲」', () => {
  assert.deepEqual(statusLabels({ archived: true }), ['已归档']);
  assert.deepEqual(statusLabels({ running: true }), ['进行中']);
  assert.deepEqual(statusLabels({ blank: true }), ['空白']);
  assert.deepEqual(statusLabels({ origin: 'subagent' }), ['子会话']);
  assert.deepEqual(statusLabels({ archived: true, running: true, origin: 'subagent' }), ['已归档', '进行中', '子会话']);
  assert.deepEqual(statusLabels({}), ['空闲']);
  assert.deepEqual(statusLabels(null), []);
});

test('readSessionIndexIds 读取原生标题 rows.title.val / titleInput 回退 / blank 标志', () => {
  const proj = join('/home', 'storages', 'session_projcache', 'sessions');
  const fs = memFs({
    [join(proj, 'session-a.json')]: JSON.stringify({
      version: 7,
      record: {
        identity: { createdAt: 1794996907221, cwd: '/work/a' },
        rows: {
          title: { ver: 1, seq: 210, val: '会话显示实时更新修复' },
          sessionListMetadata: { ver: 1, seq: 210, val: { blank: false, lastPromptAt: 1 } },
        },
      },
    }),
    [join(proj, 'session-b.json')]: JSON.stringify({
      version: 7,
      record: {
        identity: { createdAt: 1794996907222, cwd: '/work/b' },
        rows: {
          titleInput: { ver: 1, seq: 16, val: { first: { seq: 16, text: '首次输入的标题' }, count: 1 } },
          sessionListMetadata: { ver: 1, seq: 1, val: { blank: true } },
        },
      },
    }),
    [join(proj, 'session-c.json')]: JSON.stringify({
      version: 7,
      record: { identity: { createdAt: 1 }, rows: {} },
    }),
    [join(proj, 'broken.json')]: '{bad json',
  });
  const m = readSessionIndexIds(fs, '/home');
  assert.equal(m.get('session-a').title, '会话显示实时更新修复');
  assert.equal(m.get('session-a').blank, false);
  assert.equal(m.get('session-a').createdAt, 1794996907221);
  assert.equal(m.get('session-a').cwd, '/work/a');
  assert.equal(m.get('session-b').title, '首次输入的标题');
  assert.equal(m.get('session-b').blank, true);
  assert.equal(m.get('session-c').title, null);
  assert.equal(m.get('session-c').blank, null);
  assert.equal(m.has('broken'), true); // 损坏文件仍登记条目，只是字段为 null
  assert.equal(m.get('broken').title, null);
});

test('readSessionIndexIds 目录不存在时返回空 Map（fail-closed）', () => {
  assert.equal(readSessionIndexIds(memFs({}), '/home').size, 0);
});

test('readSessionIndexIds 双向登记 id：裸 UUID 文件名也能被 session- 前缀的行命中', () => {
  const proj = join('/home', 'storages', 'session_projcache', 'sessions');
  const fs = memFs({
    // 文件名是裸 UUID（这是磁盘上 958/1031 的真实形态），标题数据齐全
    [join(proj, '060b056e-7e68-4fba-8cdf-0b5d6f012d14.json')]: JSON.stringify({
      version: 7,
      record: {
        identity: { createdAt: 1, cwd: '/work/x' },
        rows: {
          title: { ver: 1, seq: 9, val: '核实DSH消息去重过滤逻辑' },
          sessionListMetadata: { val: { blank: false } },
        },
      },
    }),
  });
  const m = readSessionIndexIds(fs, '/home');
  const bare = '060b056e-7e68-4fba-8cdf-0b5d6f012d14';
  const canonical = 'session-' + bare;
  // 两种拼写必须都指向同一条记录，避免标题/blank 因前缀不一致而丢失
  assert.equal(m.get(bare).title, '核实DSH消息去重过滤逻辑');
  assert.equal(m.get(canonical).title, '核实DSH消息去重过滤逻辑');
  assert.equal(m.get(canonical).blank, false);
});

// 带 statSync 的内存 fs，用于物理目录大小扫描测试。
function sizeFs(entries) {
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/$/, '');
  const dirs = new Set(entries.map((e) => norm(e.path)));
  return {
    existsSync: (p) => {
      const np = norm(p);
      return dirs.has(np) || [...dirs].some((d) => d.startsWith(np));
    },
    readdirSync: (p) => {
      const prefix = norm(p) + '/';
      const names = new Set();
      for (const e of entries) {
        const ne = norm(e.path);
        if (!ne.startsWith(prefix)) continue;
        const rest = ne.slice(prefix.length);
        if (rest && !rest.includes('/')) names.add(rest);
      }
      return [...names];
    },
    statSync: (p) => {
      const np = norm(p);
      const e = entries.find((x) => norm(x.path) === np);
      if (e) return { isDirectory: () => !!e.dir, size: e.size || 0 };
      if (dirs.has(np)) return { isDirectory: () => true, size: 0 };
      throw new Error('ENOENT ' + p);
    },
  };
}

test('readSessionDirSizes 扫描物理目录大小，并双向登记 id', () => {
  const root = join('/home', 'sessions');
  const proj = join(root, 'project-a');
  const sessDir = join(proj, 'session-aaa');
  const bareDir = join(proj, 'bbb-plain');
  const fs = sizeFs([
    { path: root, dir: true },
    { path: proj, dir: true },
    { path: sessDir, dir: true },
    { path: join(sessDir, 'session.v4.jsonl.zstd'), size: 1000 },
    { path: join(sessDir, 'meta.bin'), size: 240 },
    { path: bareDir, dir: true },
    { path: join(bareDir, 'session.v4.jsonl.zstd'), size: 500 },
  ]);
  const sizes = readSessionDirSizes(fs, '/home');
  // canonical id 命中（session- 前缀）
  assert.equal(sizes.get('session-aaa'), 1240);
  // 裸 UUID 目录段补前缀后命中，同时保留裸拼写
  assert.equal(sizes.get('session-bbb-plain'), 500);
  assert.equal(sizes.get('bbb-plain'), 500);
});

test('readSessionDirSizes 会话根目录不存在时返回空 Map（fail-closed）', () => {
  assert.equal(readSessionDirSizes(sizeFs([]), '/home').size, 0);
});

// 构造一个最小 sessionController：list() 返回 DSH 原生形状的行——
// 标题藏在 projections.values.title，没有顶层 title 字段。
function fakeController(items) {
  return { list: async () => ({ items }) };
}

test('readFeedStatuses 读取 projections.values.title（纯运行时会话标题）', async () => {
  const ctx = { get: (name) => name === 'sessionController' ? fakeController([
    {
      sessionId: 'session-runtime',
      running: true,
      blank: false,
      // DSH 原生结构：标题在 title 投影，无顶层 title
      projections: { kind: 'sequenced', asOfSeq: 42, values: { title: '会话显示实时更新修复' } },
    },
    {
      sessionId: 'session-no-title',
      blank: true,
      // title 投影存在但值为 null
      projections: { kind: 'sequenced', asOfSeq: 8, values: { title: null } },
    },
  ]) : null };
  const feed = await readFeedStatuses(ctx);
  assert.equal(feed.get('session-runtime').title, '会话显示实时更新修复');
  assert.equal(feed.get('session-runtime').running, true);
  assert.equal(feed.get('session-no-title').title, null);
  assert.equal(feed.get('session-no-title').blank, true);
});

test('readFeedStatuses 兼容顶层 title/displayTitle，忽略空串', async () => {
  const ctx = { get: (name) => name === 'sessionController' ? fakeController([
    { sessionId: 's-top', title: '顶层标题' },
    { sessionId: 's-display', displayTitle: '显示标题' },
    { sessionId: 's-empty', title: '   ', projections: { values: { title: '投影优先' } } },
  ]) : null };
  const feed = await readFeedStatuses(ctx);
  assert.equal(feed.get('s-top').title, '顶层标题');
  assert.equal(feed.get('s-display').title, '显示标题');
  // 顶层空串被忽略，回退到投影值
  assert.equal(feed.get('s-empty').title, '投影优先');
});

test('readFeedStatuses 无 sessionController 时返回空 Map（fail-closed）', async () => {
  assert.equal((await readFeedStatuses({ get: () => null })).size, 0);
  assert.equal((await readFeedStatuses(null)).size, 0);
});
