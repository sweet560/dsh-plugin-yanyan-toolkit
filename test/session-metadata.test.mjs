// 会话管理中心 · Phase 1 数据层单测。
// 全部用内存 fs 注入，零磁盘副作用；验证原子写、并发锁、文件夹/标签 CRUD、
// 损坏账本回填、系统文件夹保护、汇总统计，以及 service 层纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';
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
});
