// 会话管理中心 · Phase 1 数据层单测。
// 全部用内存 fs 注入，零磁盘副作用；验证原子写、并发锁、文件夹/标签 CRUD、
// 损坏账本回填、系统文件夹保护、汇总统计，以及 service 层纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  METADATA_FILE_NAME,
  METADATA_VERSION,
  TRASH_FOLDER_ID,
  UNFILED_FOLDER_ID,
  emptyMetadata,
  normalizeMetadata,
  isValidId,
  isValidSessionId,
  metadataPath,
  readMetadata,
  writeMetadata,
  withMetadataLock,
  makeFolderId,
  createMetadataStore,
} from '../lib/session-metadata.js';
import {
  METADATA_API_PREFIX,
  activeSessionRows,
  displayTitle,
  createSessionHubService,
} from '../lib/session-metadata-service.js';

const HOME = '/fake/dsh-home';

/** 内存 fs：满足 writeMetadata 所需的 5 个方法。 */
function memFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    existsSync(p) { return files.has(p) || dirs.has(p); },
    mkdirSync(p) { dirs.add(p); },
    readFileSync(p) {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return files.get(p);
    },
    writeFileSync(p, data) { files.set(p, data); },
    renameSync(from, to) {
      if (!files.has(from)) throw new Error('ENOENT ' + from);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

// ---------- 基础常量与结构 ----------

test('常量与空账本结构', () => {
  assert.equal(METADATA_FILE_NAME, 'session-metadata.json');
  assert.equal(METADATA_VERSION, 1);
  assert.equal(TRASH_FOLDER_ID, '@trash');
  assert.equal(UNFILED_FOLDER_ID, '@unfiled');
  assert.deepEqual(emptyMetadata(), { version: 1, folders: {}, sessions: {} });
  assert.equal(metadataPath(HOME).endsWith('session-metadata.json'), true);
  assert.equal(METADATA_API_PREFIX, '/api/dsh-yanyan-session-hub');
});

test('isValidId 拒绝空/路径分隔符/空字节/. /.. /含..', () => {
  assert.equal(isValidId('ok-1'), true);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a..b', '../x', 'a\0b', 'x'.repeat(201)]) {
    assert.equal(isValidId(bad), false, `应拒绝: ${JSON.stringify(bad)}`);
  }
  assert.equal(isValidSessionId('session-abc'), true);
  assert.equal(isValidSessionId(''), false);
});

// ---------- 规范化（fail-closed） ----------

test('normalizeMetadata 损坏输入回填为空账本', () => {
  for (const raw of [null, undefined, 42, 'x', [], {}]) {
    assert.deepEqual(normalizeMetadata(raw), emptyMetadata());
  }
});

test('normalizeMetadata 清洗脏字段：tags 去重过滤、非法 folderId 归 null', () => {
  const out = normalizeMetadata({
    version: 99,
    folders: {
      good: { id: 'good', name: '  工作  ', createdAt: '2026-01-01' },
      'bad/id': { id: 'bad/id', name: 'x' },
      noname: { id: 'noname', createdAt: 123 },
    },
    sessions: {
      's-1': { tags: ['a', 'a', 'b', '../evil', 5, ''], folderId: 'good', customTitle: '标题' },
      'bad/id': { tags: ['x'], folderId: null, customTitle: '' },
      's-2': { tags: [], folderId: 'missing', customTitle: 3 },
    },
  });
  assert.equal(out.version, 1);
  assert.equal(out.folders.good.name, '工作');
  assert.equal(out.folders['bad/id'], undefined);
  assert.ok(out.folders.noname); // 无 name 时回填 id
  assert.deepEqual(out.sessions['s-1'].tags, ['a', 'b']);
  assert.equal(out.sessions['s-1'].folderId, 'good');
  assert.equal(out.sessions['s-1'].customTitle, '标题');
  assert.equal(out.sessions['bad/id'], undefined);
  assert.equal(out.sessions['s-2'].folderId, 'missing'); // 字符串 folderId 原样保留
  assert.equal(out.sessions['s-2'].customTitle, ''); // 非字符串回填空
});

// ---------- 原子写与锁 ----------

test('readMetadata 不存在或损坏返回空账本，不抛错', () => {
  const fs = memFs();
  assert.deepEqual(readMetadata(fs, HOME), emptyMetadata());
  fs.files.set(metadataPath(HOME), '{broken json');
  assert.deepEqual(readMetadata(fs, HOME), emptyMetadata());
});

test('writeMetadata 原子写：temp+rename，最终文件合法且无残留 .tmp', () => {
  const fs = memFs();
  const m = emptyMetadata();
  m.folders.f1 = { id: 'f1', name: '项目', createdAt: '2026-01-01' };
  writeMetadata(fs, HOME, m);
  const finalPath = metadataPath(HOME);
  assert.equal(fs.files.has(finalPath), true);
  assert.deepEqual(JSON.parse(fs.files.get(finalPath)), m);
  const leftovers = [...fs.files.keys()].filter((p) => p.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, '不应残留临时文件');
});

test('withMetadataLock 串行执行，错误不打断锁链', async () => {
  const order = [];
  const p1 = withMetadataLock(async () => { order.push('a'); await Promise.resolve(); order.push('a2'); });
  const p2 = withMetadataLock(async () => { order.push('b'); });
  const p3 = withMetadataLock(async () => { throw new Error('boom'); });
  const p4 = withMetadataLock(async () => { order.push('c'); });
  await Promise.allSettled([p1, p2, p3, p4]);
  assert.deepEqual(order, ['a', 'a2', 'b', 'c']);
});

// ---------- Store CRUD（写方法均返回 Promise，必须 await） ----------

test('文件夹 CRUD：创建/重命名/列出/删除（含归入会话退回未分类）', async () => {
  const fs = memFs();
  const store = createMetadataStore(fs, HOME);
  const f = await store.createFolder('工作项目', { id: 'work' });
  assert.equal(f.id, 'work');
  assert.equal(f.name, '工作项目');
  assert.equal(store.listFolders().length, 1);

  await store.renameFolder('work', '  核心项目  ');
  assert.equal(store.listFolders()[0].name, '核心项目');

  await store.setSessionFolder('s-1', 'work');
  assert.equal(store.getSession('s-1').folderId, 'work');
  const res = await store.deleteFolder('work');
  assert.deepEqual(res, { ok: true, moved: 1 });
  assert.equal(store.listFolders().length, 0);
  assert.equal(store.getSession('s-1').folderId, null);
  // 幂等：重复删除返回成功
  assert.deepEqual(await store.deleteFolder('work'), { ok: true, moved: 0 });
});

test('系统文件夹拒删；setSessionFolder 允许 @unfiled/@trash/null', async () => {
  const fs = memFs();
  const store = createMetadataStore(fs, HOME);
  assert.throws(() => store.deleteFolder(TRASH_FOLDER_ID), /system folder/);
  assert.throws(() => store.deleteFolder(UNFILED_FOLDER_ID), /system folder/);
  await store.setSessionFolder('s-1', TRASH_FOLDER_ID);
  assert.equal(store.getSession('s-1').folderId, TRASH_FOLDER_ID);
  await store.setSessionFolder('s-1', UNFILED_FOLDER_ID);
  assert.equal(store.getSession('s-1').folderId, UNFILED_FOLDER_ID);
  await store.setSessionFolder('s-1', null);
  assert.equal(store.getSession('s-1').folderId, null);
  assert.throws(() => store.setSessionFolder('s-1', 'bad/id'), /invalid folder id/);
});

test('标签增删幂等 + 自定义标题 + 非法入参 fail-closed', async () => {
  const fs = memFs();
  const store = createMetadataStore(fs, HOME);
  await store.addTag('s-1', '重要');
  await store.addTag('s-1', '重要'); // 幂等
  await store.addTag('s-1', '待办');
  assert.deepEqual(store.getSession('s-1').tags, ['重要', '待办']);
  await store.removeTag('s-1', '重要');
  await store.removeTag('s-1', '不存在'); // 幂等
  assert.deepEqual(store.getSession('s-1').tags, ['待办']);
  await store.setCustomTitle('s-1', '我的会话');
  assert.equal(store.getSession('s-1').customTitle, '我的会话');

  // 前置参数校验是同步抛错（在进入 mutate/锁之前）。
  assert.throws(() => store.addTag('bad/id', 'x'), /invalid session id/);
  assert.throws(() => store.addTag('s-1', ''), /invalid tag/);
  assert.throws(() => store.createFolder('  '), /folder name required/);
  // mutate 内部的领域校验在 Promise 链里异步 reject。
  await assert.rejects(() => store.renameFolder('nope', 'x'), /folder not found/);
  await store.createFolder('首次', { id: 'dup' });
  await assert.rejects(() => store.createFolder('重复', { id: 'dup' }), /folder exists/);
});

test('allTags / overview 汇总统计', async () => {
  const fs = memFs();
  const store = createMetadataStore(fs, HOME);
  await store.createFolder('A', { id: 'fa' });
  await store.createFolder('B', { id: 'fb' });
  await store.setSessionFolder('s1', 'fa');
  await store.setSessionFolder('s2', 'fa');
  await store.setSessionFolder('s3', null);
  await store.addTag('s1', 'x');
  await store.addTag('s2', 'x');
  await store.addTag('s2', 'y');
  assert.deepEqual(store.allTags(), [{ tag: 'x', count: 2 }, { tag: 'y', count: 1 }]);
  const ov = store.overview();
  assert.equal(ov.total, 3);
  assert.equal(ov.folderCounts.fa, 2);
  assert.equal(ov.folderCounts[UNFILED_FOLDER_ID], 1);
  assert.equal(ov.tagCounts.x, 2);
});

test('makeFolderId 生成 slug-时间戳-随机 的唯一 id', () => {
  const a = makeFolderId('我的 Project', 1000, () => 0.123456);
  const b = makeFolderId('我的 Project', 1001, () => 0.654321);
  assert.notEqual(a, b);
  assert.match(a, /^project-[a-z0-9]+-[a-z0-9]+$/);
});

// ---------- 持久化：新实例读到旧实例写入的数据 ----------

test('store 写入后新 store 实例可读到（真实持久化）', async () => {
  const fs = memFs();
  const s1 = createMetadataStore(fs, HOME);
  await s1.createFolder('持久', { id: 'persist' });
  await s1.addTag('s9', '留存');
  const s2 = createMetadataStore(fs, HOME);
  assert.equal(s2.getSession('s9').tags.includes('留存'), true);
  assert.equal(s2.listFolders().some((f) => f.id === 'persist'), true);
});

// ---------- service 层纯函数 ----------

test('activeSessionRows 兼容 byId 快照与数组两种形态', () => {
  const byId = {
    a: { id: 'a', title: 'A' },
    b: { id: 'b', label: 'B' },
  };
  const rows = activeSessionRows({ list: { getSnapshot: () => ({ byId }) } });
  assert.equal(rows.length, 2);
  assert.equal(rows.some((r) => r.id === 'a' || r.sessionId === 'a'), true);
  assert.equal(activeSessionRows(null).length, 0);
  assert.equal(activeSessionRows({ list: { getSnapshot: () => ({ byId: { a: { title: 'A' } } }) } }).length, 1);
});

test('displayTitle 优先级：customTitle > 原生标题 > 短 id', () => {
  assert.equal(displayTitle({ title: '原生' }, { customTitle: '自定义' }), '自定义');
  assert.equal(displayTitle({ title: '原生' }, {}), '原生');
  assert.equal(displayTitle({ label: '标签名' }, {}), '标签名');
  assert.equal(displayTitle({ id: 'abc' }, {}), 'abc');
});

// ---------- 回收站增强：trashList 补 tags/workspace ----------

test('service.trashList 给回收站条目补 tags（来自 metadata）与 workspace（来自 cwd）', async () => {
  const fs = {
    existsSync: (p) => String(p).endsWith('workspace.json'),
    readFileSync: () => JSON.stringify({
      tables: { workspaces: { w1: { id: 'w1', title: '演示工作区', path: HOME } } },
    }),
    // store/searchIndex/exporter 均注入，fs 只需满足 readWorkspaces
  };
  const store = {
    getSession: (id) => (id === 'session-tagged' ? { tags: ['项目A', '重要'], folderId: null, customTitle: null } : null),
  };
  const trashService = {
    list: async () => ({
      ok: true,
      entries: [
        { id: 'session-tagged', title: 'T', content: 'hello', cwd: HOME + '/sub', trashedAt: 1 },
        { id: 'session-plain', title: 'P', content: '', cwd: null, trashedAt: 2 },
      ],
      count: 2,
    }),
  };
  const searchIndex = { listSessions: () => [], rebuild: async () => null };
  const exporter = { export: async () => ({ ok: true }) };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store,
    trashService,
    searchIndex,
    exporter,
    autoIndex: false,
  });
  const res = await service.trashList();
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  const tagged = res.entries.find((e) => e.id === 'session-tagged');
  const plain = res.entries.find((e) => e.id === 'session-plain');
  assert.deepEqual(tagged.tags, ['项目A', '重要'], 'tags 来自 metadata store');
  assert.equal(tagged.workspace, '演示工作区', 'workspace 由 cwd 最长前缀匹配派生');
  assert.equal(tagged.content, 'hello', 'content 原样透传供内容搜索');
  assert.deepEqual(plain.tags, [], '无 metadata 的条目 tags 回退空数组');
  assert.equal(plain.workspace, null, '无 cwd 的条目 workspace 回退 null');
  // 回收站条目状态：天然已归档；有标题则不标空会话。
  assert.deepEqual(tagged.status, ['已归档'], '有标题的回收站条目状态为已归档（不误标空会话）');
});

test('service.trashList 给回收站条目补 status：子会话检出 origin、无标题标空会话', async () => {
  const fs = {
    existsSync: (p) => String(p).endsWith('workspace.json'),
    readFileSync: () => JSON.stringify({ tables: { workspaces: {} } }),
  };
  const store = { getSession: () => null };
  const trashService = {
    list: async () => ({
      ok: true,
      entries: [
        { id: 'session-sub', title: '子会话标题', content: '', cwd: null, origin: 'subagent', trashedAt: 1 },
        { id: 'session-blank', title: null, content: '', cwd: null, origin: null, trashedAt: 2 },
      ],
      count: 2,
    }),
  };
  const service = createSessionHubService({}, {
    dshHome: HOME, fs, store, trashService,
    searchIndex: { listSessions: () => [], rebuild: async () => null },
    exporter: { export: async () => ({ ok: true }) }, autoIndex: false,
  });
  const res = await service.trashList();
  const sub = res.entries.find((e) => e.id === 'session-sub');
  const blank = res.entries.find((e) => e.id === 'session-blank');
  assert.deepEqual(sub.status, ['已归档', '子会话'], 'origin=subagent 检出子会话状态');
  assert.deepEqual(blank.status, ['空会话', '已归档', '空白'], '无标题先标空会话，再标已归档/空白');
});

// ---------- 会话标题：feed 实时标题（projections.values.title）覆盖空会话误判 ----------

test('service.list 用 feed 实时标题，纯运行时会话不再显示 id/空会话', async () => {
  // 模拟截图里的问题会话 session-1034796d：只在 sessionController 内存里、无 projcache/日志。
  const runtimeId = 'session-1034796d-8f4f-4b71-a7e9-c97893450346';
  const fs = {
    existsSync: (p) => String(p).endsWith('workspace.json'),
    readFileSync: () => JSON.stringify({ tables: { workspaces: {} } }),
    readdirSync: () => [], // 无 projcache、无日志目录
  };
  const store = { snapshot: () => ({ folders: {}, sessions: {} }), overview: () => ({}), listFolders: () => [], allTags: () => [] };
  // 活跃会话行：DSH 原生结构——无顶层 title，标题在 projections.values.title
  const sessions = { list: { getSnapshot: () => ({ byId: {
    [runtimeId]: {
      id: runtimeId,
      running: true,
      updatedAt: 1794997200000,
      projections: { kind: 'sequenced', asOfSeq: 30, values: { title: '会话显示实时更新修复' } },
    },
  } }) } };
  // sessionController 的 list 走 ctx.get，返回同样的 projections 结构
  const ctx = {
    get: (name) => name === 'sessionController'
      ? { list: async () => ({ items: [{ sessionId: runtimeId, running: true, projections: { values: { title: '会话显示实时更新修复' } } }] }) }
      : null,
  };
  const service = createSessionHubService(ctx, {
    dshHome: HOME,
    fs,
    store,
    sessions,
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService: { list: async () => ({ ok: true, entries: [], count: 0 }) },
    autoIndex: false,
  });
  const res = await service.list();
  assert.equal(res.ok, true);
  const item = res.items.find((x) => x.id === runtimeId);
  assert.ok(item, '纯运行时会话应出现在列表');
  assert.equal(item.title, '会话显示实时更新修复', '标题来自 feed projections.values.title');
  assert.equal(item.empty, false, '有实时标题不应标记为空会话');
  assert.equal(item.status.includes('空会话'), false, '状态 chip 不应含「空会话」');
  assert.equal(item.running, true, '运行状态保持来自 feed');
});

// ---------- 会话大小：物理日志目录大小进入 item（修复所有会话无大小） ----------

test('service.list 给会话补物理目录大小 size（不再全部为 null）', async () => {
  // 会话 id 用裸 UUID 行，日志目录段用 session- 前缀，验证双向规范化也能命中大小。
  const bare = 'cb3698ac-1111-2222-3333-444455556666';
  const canonical = 'session-' + bare;
  const root = join(HOME, 'sessions');
  const proj = join(root, 'project-a');
  const sessDir = join(proj, canonical);
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/$/, '');
  const dirs = new Set([norm(root), norm(proj), norm(sessDir)]);
  const files = {
    [norm(sessDir) + '/session.v4.jsonl.zstd']: 105446,
  };
  const fs = {
    existsSync: (p) => {
      const np = norm(p);
      return np.endsWith('workspace.json') || dirs.has(np) || [...dirs].some((d) => d.startsWith(np))
        || Object.keys(files).some((f) => f.startsWith(np));
    },
    readFileSync: () => JSON.stringify({ tables: { workspaces: {} } }),
    readdirSync: (p) => {
      const np = norm(p);
      if (np.endsWith('sessions')) return ['project-a']; // projcache 目录无内容
      const prefix = np + '/';
      const names = new Set();
      for (const d of dirs) if (d.startsWith(prefix) && d.slice(prefix.length) && !d.slice(prefix.length).includes('/')) names.add(d.slice(prefix.length));
      for (const f of Object.keys(files)) if (f.startsWith(prefix) && f.slice(prefix.length) && !f.slice(prefix.length).includes('/')) names.add(f.slice(prefix.length));
      return [...names];
    },
    statSync: (p) => {
      const np = norm(p);
      if (dirs.has(np)) return { isDirectory: () => true, size: 0 };
      if (files[np] !== undefined) return { isDirectory: () => false, size: files[np] };
      throw new Error('ENOENT ' + p);
    },
  };
  const store = { snapshot: () => ({ folders: {}, sessions: {} }), overview: () => ({}), listFolders: () => [], allTags: () => [] };
  const sessions = { list: { getSnapshot: () => ({ byId: { [bare]: { id: bare, title: '有大小的会话', updatedAt: 1 } } }) } };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store,
    sessions,
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService: { list: async () => ({ ok: true, entries: [], count: 0 }) },
    autoIndex: false,
  });
  const res = await service.list();
  const item = res.items.find((x) => x.id === bare);
  assert.ok(item, '会话应出现在列表');
  assert.equal(item.size, 105446, 'size 来自物理日志目录大小（裸 id 行命中 session- 前缀目录）');
});

// —— 批量删除已归档会话（m01591）：幽灵会话分组 + canonical 双向匹配 ——
test('service.deleteArchived 对已在回收站的会话直接 purge，跳过 trash 阶段', async () => {
  const trashedId = 'session-2456ab5d-ad5a-4449-8eb5-1011b98b4656';
  let trashCalled = 0;
  let purgedIds = null;
  const trashService = {
    isTrashed: (id) => canonical === id, // 仅 trashedId 在回收站
    trash: async (ids) => { trashCalled++; return { ok: true, moved: ids.length, results: [] }; },
    purge: async (ids) => {
      purgedIds = ids;
      return { ok: true, purged: ids.length, results: ids.map((id) => ({ id, status: 'ok' })) };
    },
  };
  const canonical = trashedId;
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs: memFs(),
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService,
    autoIndex: false,
  });
  // 单独一条幽灵会话：应直接 purge，且绝不调用 trash。
  const res = await service.deleteArchived([trashedId]);
  assert.equal(res.ok, true);
  assert.equal(trashCalled, 0, '已在回收站的会话不应调用 trash()');
  assert.deepEqual(purgedIds, [trashedId], '幽灵会话直接进入 purge');
  assert.deepEqual(res.done, [trashedId]);
  assert.deepEqual(res.failed, []);
});

test('service.deleteArchived 混合列表：幽灵走 purge、正常走 trash→purge，互不拖垮', async () => {
  const ghost = 'session-2456ab5d-ad5a-4449-8eb5-1011b98b4656';
  const normal = 'session-aaa-normal';
  const trashed = new Set([ghost]);
  const trashedCalls = [];
  const purgeCalls = [];
  const trashCalls = [];
  const trashService = {
    isTrashed: (id) => trashed.has(canonicalId(id)),
    trash: async (ids) => {
      trashCalls.push(...ids);
      // 正常会话 trash 成功；若这里收到幽灵则说明分组失败。
      return { ok: true, moved: ids.length, results: ids.map((id) => ({ id, status: 'ok' })) };
    },
    purge: async (ids) => {
      purgeCalls.push(...ids);
      return { ok: true, purged: ids.length, results: ids.map((id) => ({ id, status: 'ok' })) };
    },
  };
  const canonicalId = (id) => String(id).startsWith('session-') ? id : 'session-' + id;
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs: memFs(),
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService,
    autoIndex: false,
  });
  const res = await service.deleteArchived([ghost, normal]);
  assert.equal(res.ok, true);
  assert.deepEqual(trashCalls, [normal], '只有未在回收站的会话走 trash');
  assert.ok(purgeCalls.includes(ghost) && purgeCalls.includes(normal), '两条都进入 purge（分两批）');
  assert.equal(res.done.length, 2, '两条都成功，不再整批 rejected');
  assert.deepEqual(res.failed, []);
});

test('service.deleteArchived 解档后置：只解档成功删除的会话，失败的不解档（防未命名幽灵 m02120）', async () => {
  const ghost = 'session-ghost-purged';      // 已在回收站 → purge 成功
  const failOne = 'session-fail-trash';       // 不在回收站 → trash 预检失败
  const unarchived = [];
  const trashService = {
    isTrashed: (id) => id === ghost,
    trash: async (ids) => ({ ok: false, moved: 0, rejected: ids.map((id) => ({ id, reason: 'locate failed' })), results: [] }),
    purge: async (ids) => ({ ok: true, purged: ids.length, results: ids.map((id) => ({ id, status: 'ok' })) }),
  };
  const registry = {
    unarchiveSession: async (id) => { unarchived.push(id); return { archivedSessionIds: [] }; },
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs: memFs(),
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService,
    registry,
    autoIndex: false,
  });
  const res = await service.deleteArchived([ghost, failOne]);
  assert.equal(res.ok, false, '有失败项则整体失败');
  assert.deepEqual(res.done, [ghost], '只有幽灵会话 purge 成功');
  assert.ok(res.failed.some((f) => f.id === failOne), 'trash 失败的会话进入 failed');
  assert.ok(unarchived.includes(ghost), '只解档成功删除的会话（含其拼写变体）');
  assert.equal(unarchived.includes(failOne) || unarchived.includes(failOne.replace(/^session-/, '')), false,
    '失败的 session-fail-trash 不得解档');
});

// —— 会话总数重复计数（m02649）：裸 UUID 与 session- 前缀必须视为同一会话 ——
test('service.list 去重：裸 UUID 与 session- 前缀两种拼写只算一条（231→118）', async () => {
  const bare = '1a345f20-aaaa-bbbb-cccc-1234567890ab';
  const canon = 'session-' + bare;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/$/, '');
  const projcacheDir = norm(join(HOME, 'storages', 'session_projcache', 'sessions'));
  const projcacheFile = projcacheDir + '/' + bare + '.json';
  const projcacheDoc = JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: 1000, cwd: 'F:\\demo\\workspace' },
      rows: { title: { val: '去重测试会话' } },
    },
  });
  const fs = {
    existsSync: (p) => {
      const np = norm(p);
      return np === projcacheDir || np === projcacheFile || np.endsWith('workspace.json');
    },
    readFileSync: (p) => {
      const np = norm(p);
      if (np === projcacheFile) return projcacheDoc;
      if (np.endsWith('workspace.json')) return JSON.stringify({ tables: { workspaces: {} } });
      throw new Error('ENOENT ' + p);
    },
    readdirSync: (p) => {
      const np = norm(p);
      if (np === projcacheDir) return [bare + '.json']; // projcache 文件名是裸 UUID
      return []; // sessions 目录无物理日志
    },
    statSync: () => { throw new Error('ENOENT'); },
  };
  // 索引侧日志段名带 session- 前缀，与 projcache 裸 UUID 文件名形成两种拼写。
  const searchIndex = { listSessions: () => [{ id: canon, title: null, updatedAt: 1000 }] };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex,
    exporter: { export: async () => ({ ok: true }) },
    trashService: { list: async () => ({ ok: true, entries: [], count: 0 }) },
    autoIndex: false,
  });
  const res = await service.list();
  const matches = res.items.filter((x) => x.id === bare || x.id === canon);
  assert.equal(matches.length, 1, '同一会话的裸 UUID 与 session- 前缀拼写只应计为一条');
  assert.ok(canon === matches[0].id, '保留带 session- 前缀的规范 id');
});

// —— 根治 m03137：账本 deleteSession API（幂等，删后不留孤儿） ——
test('createMetadataStore.deleteSession 删除会话条目且幂等', async () => {
  const fs = memFs();
  const store = createMetadataStore(fs, HOME);
  const sid = 'session-to-delete';
  await store.addTag(sid, '重要');
  assert.equal(store.getSession(sid) !== null, true, '写入后账本有该会话');
  const r1 = await store.deleteSession(sid);
  assert.equal(r1.deleted, true, '第一次删除返回 deleted:true');
  assert.equal(store.getSession(sid), null, '删除后账本无该会话');
  const r2 = await store.deleteSession(sid);
  assert.equal(r2.deleted, false, '再次删除幂等，返回 deleted:false 不报错');
});

// —— 根治 m03137：列表兜底过滤物理/账本/归档/回收站都不存在的幽灵空壳 ——
test('service.list 幽灵空壳不再显示（仅 projcache 有、物理/账本/归档全无）', async () => {
  const ghost = 'session-ghost-shell';
  const norm = (s) => { let x = String(s).split(String.fromCharCode(92)).join('/'); return x.endsWith('/') ? x.slice(0, -1) : x; };
  const projcacheDir = norm(join(HOME, 'storages', 'session_projcache', 'sessions'));
  const projcacheFile = projcacheDir + '/' + ghost + '.json';
  const projcacheDoc = JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: 1000, cwd: 'F:\\\\demo\\\\workspace' },
      rows: { title: { val: '幽灵残留会话' } },
    },
  });
  const fs = {
    existsSync: (p) => {
      const np = norm(p);
      return np === projcacheDir || np === projcacheFile || np.endsWith('workspace.json');
    },
    readFileSync: (p) => {
      const np = norm(p);
      if (np === projcacheFile) return projcacheDoc;
      if (np.endsWith('workspace.json')) return JSON.stringify({ tables: { workspaces: {} } });
      throw new Error('ENOENT ' + p);
    },
    readdirSync: (p) => {
      const np = norm(p);
      if (np === projcacheDir) return [ghost + '.json'];
      return []; // sessions 目录无物理日志
    },
    statSync: () => { throw new Error('ENOENT'); },
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService: { list: async () => ({ ok: true, entries: [], count: 0 }) },
    autoIndex: false,
  });
  const res = await service.list();
  assert.equal(res.items.some((x) => x.id === ghost || x.id === ghost.replace(/^session-/, '')), false,
    '幽灵空壳不应出现在会话列表');
});

// —— 归档幽灵（m03440）：只在归档清单里、无任何物理数据的会话，删除时不得整批失败 ——
test('service.deleteArchived 归档幽灵直接解档清理，不走 trash→purge（m03440）', async () => {
  const ghost = 'session-arch-ghost-8f34977d';
  const unarchived = [];
  const trashCalls = [];
  const purgeCalls = [];
  const deletedSessions = [];
  const trashService = {
    isTrashed: () => false,
    trash: async (ids) => { trashCalls.push(...ids); return { ok: true, results: ids.map((id) => ({ id, status: 'ok' })) }; },
    purge: async (ids) => { purgeCalls.push(...ids); return { ok: true, results: ids.map((id) => ({ id, status: 'ok' })) }; },
  };
  const registry = {
    // 归档清单里有它；但 memFs 无物理目录、无 projcache、无 feed → 判定为归档幽灵
    archivedSessionIds: [ghost],
    unarchiveSession: async (id) => { unarchived.push(id); return { archivedSessionIds: [] }; },
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs: memFs(),
    store: {
      snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [],
      deleteSession: async (id) => { deletedSessions.push(id); return { ok: true, deleted: true }; },
    },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService,
    registry,
    autoIndex: false,
  });
  const res = await service.deleteArchived([ghost]);
  assert.equal(res.ok, true, '归档幽灵清理应成功，不整批失败');
  assert.deepEqual(res.done, [ghost], '幽灵计入 done');
  assert.equal(trashCalls.length, 0, '归档幽灵不得走 trash（preflight locate 必然失败）');
  assert.equal(purgeCalls.length, 0, '归档幽灵无物理可 purge');
  assert.ok(unarchived.includes(ghost), '归档幽灵应从归档清单移除（含其拼写变体）');
});

// —— 归档口径对齐（m04137）：归档清单里的会话即使物理已无也保留，与「会话归档管理」56 口径一致 ——
test('service.list 归档清单会话（物理已无）也保留，与归档管理口径对齐（m04137）', async () => {
  const archivedOnly = 'session-arch-only-no-data';
  const fs = {
    existsSync: (p) => String(p).endsWith('workspace.json'),
    readFileSync: (p) => {
      if (String(p).endsWith('workspace.json')) {
        return JSON.stringify({ tables: { workspaces: {} }, global: { archivedSessionIds: [archivedOnly] } });
      }
      throw new Error('ENOENT ' + p);
    },
    readdirSync: () => [], // sessions / projcache 目录都不存在
    statSync: () => { throw new Error('ENOENT'); },
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService: { list: async () => ({ ok: true, entries: [], count: 0 }) },
    autoIndex: false,
  });
  const res = await service.list();
  assert.equal(res.items.some((x) => x.id === archivedOnly || x.id === archivedOnly.replace(/^session-/, '')), true,
    '归档清单里的会话应保留，与会话归档管理的计数口径一致');
});

// —— 回收站过滤（m00490）：移入回收站的会话即使归档清单仍有残留，也不得混进会话/归档列表 ——
test('service.list 过滤已在回收站的会话，避免其显示为已归档（m00490）', async () => {
  const trashedId = 'session-in-trash-90';
  const keepId = 'session-keep-archived-90';
  const fs = {
    existsSync: (p) => String(p).endsWith('workspace.json'),
    readFileSync: (p) => {
      if (String(p).endsWith('workspace.json')) {
        return JSON.stringify({ tables: { workspaces: {} }, global: { archivedSessionIds: [trashedId, keepId] } });
      }
      throw new Error('ENOENT ' + p);
    },
    readdirSync: () => [], // sessions / projcache 目录都不存在
    statSync: () => { throw new Error('ENOENT'); },
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService: {
      list: async () => ({ ok: true, entries: [], count: 0 }),
      isTrashed: (id) => id === trashedId, // 仅 trashedId 已在回收站
    },
    autoIndex: false,
  });
  const res = await service.list();
  assert.equal(res.items.some((x) => x.id === trashedId), false,
    '已在回收站的会话不得出现在会话/归档列表（只应见于回收站 tab 的独立数据源）');
  assert.equal(res.items.some((x) => x.id === keepId), true,
    '未进回收站的普通归档会话仍应保留，与归档管理口径一致');
});

test('service.trashMove 失败时带出 message（m03928，避免前端裸 request failed）', async () => {
  const rejected = [{ id: 'session-ghostmove', reason: 'not found by locate()' }];
  const trashService = {
    list: async () => ({ ok: true, entries: [], count: 0 }),
    trash: async () => ({ ok: false, moved: 0, failed: 0, rejected, results: [] }),
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs: { existsSync: () => false },
    store: { snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [] },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService,
    autoIndex: false,
  });
  const res = await service.trashMove(['session-ghostmove']);
  assert.equal(res.ok, false);
  assert.match(res.message, /session-ghostmove/);
  assert.match(res.message, /not found by locate\(\)/);
});

test('service.list 主路径过滤磁盘四路全无的幽灵会话（m03995）', async () => {
  const realId = 'session-real-main';
  const ghostId = 'session-ghost-main';
  const fs = {
    existsSync: (p) => String(p).endsWith('workspace.json'),
    readFileSync: () => JSON.stringify({ tables: { workspaces: {} }, global: { archivedSessionIds: [] } }),
    readdirSync: () => [], // 无 projcache、无日志目录
    statSync: () => { throw new Error('ENOENT'); },
  };
  const store = { snapshot: () => ({ folders: {}, sessions: {} }), overview: () => ({}), listFolders: () => [], allTags: () => [] };
  // 两条都出现在活跃会话行（主路径数据源），但只有 real 在 feed 有实时标题
  const sessions = { list: { getSnapshot: () => ({ byId: {
    [realId]: { id: realId, running: true, updatedAt: 1 },
    [ghostId]: { id: ghostId, running: false, updatedAt: 1 },
  } }) } };
  const ctx = {
    get: (name) => name === 'sessionController'
      ? { list: async () => ({ items: [{ sessionId: realId, running: true, projections: { values: { title: '真实在用会话' } } }] }) }
      : null,
  };
  const service = createSessionHubService(ctx, {
    dshHome: HOME,
    fs,
    store,
    sessions,
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService: { list: async () => ({ ok: true, entries: [], count: 0 }) },
    autoIndex: false,
  });
  const res = await service.list();
  assert.equal(res.items.some((x) => x.id === realId), true, 'feed 有标题的真实会话必须保留');
  assert.equal(res.items.some((x) => x.id === ghostId || x.id === ghostId.replace(/^session-/, '')), false,
    '磁盘四路全无、feed 也无标题/运行态的幽灵必须从主路径过滤');
});

// —— 「删两次」根因（m04242/m04308）：裸 id 归档幽灵解档失败，归档标记清不掉导致死而复生 ——
test('service.deleteArchived 裸 id 归档幽灵：多拼写解档 + 归档清单文件兜底，一次删干净（m04242）', async () => {
  const bareGhost = 'mnemon-task-v1-2f2d87fe-test'; // 裸 id（无 session- 前缀），正是删不掉的那类
  const canonGhost = 'session-' + bareGhost;
  const workspacePath = join(HOME, 'storages', 'workspace.json');
  const fs = memFs();
  fs.files.set(workspacePath, JSON.stringify({
    tables: { workspaces: {} },
    global: { archivedSessionIds: [bareGhost, 'session-keep-me'] },
  }));
  const unarchived = [];
  const trashCalls = [];
  const purgeCalls = [];
  const registry = {
    archivedSessionIds: [bareGhost, 'session-keep-me'],
    unarchiveSession: async (id) => { unarchived.push(id); return { archivedSessionIds: [] }; },
  };
  const trashService = {
    isTrashed: () => false,
    trash: async (ids) => { trashCalls.push(...ids); return { ok: true, results: ids.map((id) => ({ id, status: 'ok' })) }; },
    purge: async (ids) => { purgeCalls.push(...ids); return { ok: true, results: ids.map((id) => ({ id, status: 'ok' })) }; },
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store: {
      snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [],
      deleteSession: async () => ({ ok: true, deleted: true }),
    },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService,
    registry,
    autoIndex: false,
  });
  const res = await service.deleteArchived([bareGhost]);
  assert.equal(res.ok, true, '归档幽灵应一次清理成功');
  assert.deepEqual(res.done, [bareGhost]);
  assert.equal(trashCalls.length, 0, '归档幽灵不走 trash');
  assert.equal(purgeCalls.length, 0, '归档幽灵无物理可 purge');
  // 主修复：三种拼写都尝试解档，确保宿主的 session- 前缀规范化匹配能命中
  assert.equal(unarchived.includes(bareGhost), true, '应尝试裸 id 解档');
  assert.equal(unarchived.includes(canonGhost), true, '应尝试 session- 前缀拼写解档（原生按此规范化）');
  // 兜底：workspace.json 归档清单里裸 id 被移除，其它会话不受影响
  const ws = JSON.parse(fs.files.get(workspacePath));
  assert.equal(ws.global.archivedSessionIds.includes(bareGhost), false, '裸 id 应从归档清单文件移除');
  assert.equal(ws.global.archivedSessionIds.includes('session-keep-me'), true, '其它归档会话不得误删');
});

// —— 原生会话右键菜单「删除」（m04502）：统一 deleteAny 按归档状态分流 ——
test('service.deleteAny 按归档状态分流：归档→deleteArchived、未归档→trashMove（m04502）', async () => {
  const archivedId = 'session-aarchived-0001';
  const activeId = 'session-bactive-0002';
  const workspacePath = join(HOME, 'storages', 'workspace.json');
  const fs = memFs();
  fs.files.set(workspacePath, JSON.stringify({
    tables: { workspaces: {} },
    global: { archivedSessionIds: [archivedId] },
  }));
  const unarchived = [];
  const trashCalls = [];
  const registry = {
    archivedSessionIds: [archivedId],
    unarchiveSession: async (id) => { unarchived.push(id); return { archivedSessionIds: [] }; },
  };
  const trashService = {
    isTrashed: () => false,
    trash: async (ids) => { trashCalls.push(...ids); return { ok: true, results: ids.map((id) => ({ id, status: 'ok' })) }; },
    purge: async (ids) => ({ ok: true, results: ids.map((id) => ({ id, status: 'ok' })) }),
  };
  const service = createSessionHubService({}, {
    dshHome: HOME,
    fs,
    store: {
      snapshot: () => ({ folders: {}, sessions: {} }), allTags: () => [], overview: () => ({}), listFolders: () => [],
      deleteSession: async () => ({ ok: true, deleted: true }),
    },
    searchIndex: { listSessions: () => [] },
    exporter: { export: async () => ({ ok: true }) },
    trashService,
    registry,
    autoIndex: false,
  });
  const res = await service.deleteAny([archivedId, activeId]);
  assert.equal(res.ok, true, '两条都应处理成功');
  assert.equal(res.done.length, 2, '两条都应计入 done');
  assert.equal(unarchived.includes(archivedId) || unarchived.includes(archivedId.replace(/^session-/, '')), true,
    '归档会话应走 deleteArchived 解档');
  assert.deepEqual(trashCalls, [activeId], '只有未归档会话应走 trashMove 进回收站');
  assert.equal(trashCalls.includes(archivedId), false, '归档会话不得再进回收站（直接删除语义）');

  // 空数组 / 归档清单读不到时 fail-closed：全部按未归档处理，不直接删除
  const emptyRes = await service.deleteAny([]);
  assert.deepEqual(emptyRes, { ok: true, done: [], failed: [] });
});
