// host 侧物理删除相关纯函数的单元测试。不触碰真实 DSH_HOME，只用临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);

const {
  coreId, spellings, isVirtualId, isInside, isSafeSessionId,
  stripCatalogEntries, catalogFilePath, resolveDshHome, purgePhysical,
} = mod;

function tmpHome() {
  const root = mkdtempSync(join(tmpdir(), 'yanyan-purge-'));
  mkdirSync(join(root, 'sessions', 'proj-a'), { recursive: true });
  mkdirSync(join(root, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  mkdirSync(join(root, 'dsh-session-archive'), { recursive: true });
  return root;
}
function writeJson(p, obj) { writeFileSync(p, JSON.stringify(obj), 'utf8'); }
function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

test('coreId / spellings 覆盖两种拼写', () => {
  assert.equal(coreId('abc'), 'abc');
  assert.equal(coreId('session-abc'), 'abc');
  assert.deepEqual(spellings('session-abc'), ['abc', 'session-abc']);
  assert.deepEqual(spellings('abc'), ['abc', 'session-abc']);
});

test('isVirtualId 识别 mnemon 虚拟委派，普通会话返回 false', () => {
  assert.equal(isVirtualId('mnemon-run-v1-debd95cd-2980-4801-9299-c1da04bc5775'), true);
  assert.equal(isVirtualId('session-mnemon-task-v1-0886a34a-e23d-4555-8b96-2b98e25712a0'), true);
  assert.equal(isVirtualId('session-f2d52ae9-ef44-43c5-a4cf-49df636c8e83'), false);
  assert.equal(isVirtualId('agent-1'), false);
});

test('isSafeSessionId 拒绝路径穿越字符', () => {
  assert.equal(isSafeSessionId('mnemon-run-v1-abc'), true);
  assert.equal(isSafeSessionId('session-abc'), true);
  assert.equal(isSafeSessionId('../etc'), false);
  assert.equal(isSafeSessionId('a/b'), false);
  assert.equal(isSafeSessionId('a\\b'), false);
  assert.equal(isSafeSessionId(''), false);
});

test('isInside 阻止越界路径', () => {
  const root = join(tmpdir(), 'yanyan-root');
  assert.equal(isInside(root, join(root, 'a', 'b')), true);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, join(root, '..', 'escape')), false);
});

test('stripCatalogEntries 递归清理 head 与 previous 分片，返回计数', () => {
  const rec = {
    record: { rows: { subagentCatalog: { val: { head: {
      values: [
        { childId: 'keep-1', label: 'A' },
        { childId: 'mnemon-run-v1-ghost', label: 'Ghost' },
        { childId: 'session-mnemon-run-v1-ghost', label: 'Ghost2' },
      ],
      previous: {
        values: [
          { childId: 'old-1', label: 'Old' },
          { id: 'mnemon-run-v1-ghost', label: 'Ghost3' },
        ],
        previous: null,
      },
    } } } } },
  };
  const r = stripCatalogEntries(rec, ['mnemon-run-v1-ghost']);
  assert.equal(r.changed, true);
  assert.equal(r.removed, 3, 'head 两条 + previous 一条都应命中');
  const head = rec.record.rows.subagentCatalog.val.head;
  assert.deepEqual(head.values.map((v) => v.childId), ['keep-1']);
  assert.deepEqual(head.previous.values.map((v) => v.childId || v.id), ['old-1']);
  const none = stripCatalogEntries(rec, ['not-here']);
  assert.equal(none.changed, false);
  assert.equal(none.removed, 0);
});

test('catalogFilePath 对带 / 不带 session- 前缀都指向同一文件', () => {
  const a = catalogFilePath('/home', 'abc');
  const b = catalogFilePath('/home', 'session-abc');
  assert.equal(a, b);
  assert.ok(a.includes('session-abc.json'));
});

test('resolveDshHome 优先环境变量，其次 profileContext.dir 上溯找含 storages/sessions 的祖先', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = '/env/home';
  assert.equal(resolveDshHome({ get: () => undefined }), '/env/home');
  delete process.env.DSH_HOME;
  const home = tmpHome(); // 含 storages/ 与 sessions/
  try {
    const profileDir = join(home, 'profiles', 'desktop');
    mkdirSync(profileDir, { recursive: true });
    const ctx = { get: (n) => (n === 'profileContext' ? { dir: profileDir } : undefined) };
    assert.equal(resolve(home), resolve(resolveDshHome(ctx)));
    assert.equal(resolveDshHome({ get: () => undefined }), '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  if (prev !== undefined) process.env.DSH_HOME = prev;
});

test('purgePhysical 清目录 / projcache 引用 / workspace 归档标记 / 台账，且不误删其它条目', () => {
  const home = tmpHome();
  try {
    const ghost = 'mnemon-run-v1-ghost';
    // 会话目录（两种拼写）
    mkdirSync(join(home, 'sessions', 'proj-a', ghost), { recursive: true });
    writeFileSync(join(home, 'sessions', 'proj-a', ghost, 'session.v4.jsonl.zstd'), 'x');
    mkdirSync(join(home, 'sessions', 'proj-a', 'session-' + ghost), { recursive: true });
    // 幽灵自己的 projcache
    writeJson(join(home, 'storages', 'session_projcache', 'sessions', ghost + '.json'), { record: {} });
    // 父会话 projcache 里的 catalog 引用
    writeJson(join(home, 'storages', 'session_projcache', 'sessions', 'session-parent.json'), {
      record: { rows: { subagentCatalog: { val: { head: {
        values: [
          { childId: 'keep-1', label: 'Keep' },
          { childId: ghost, label: 'Ghost' },
          { childId: 'session-other', label: 'Other' },
        ], previous: null,
      } } } } },
    });
    // workspace.json：归档标记 + 成员
    writeJson(join(home, 'storages', 'workspace.json'), {
      global: { archivedSessionIds: ['session-' + ghost, 'session-keep'] },
      tables: { workspaces: { w1: { sessionIds: ['session-' + ghost, 'session-keep'] } } },
    });
    // 归档台账
    writeJson(join(home, 'dsh-session-archive', 'archive-ledger.json'), {
      version: 1,
      entries: { [ghost]: { archivedAt: 1 }, 'session-keep': { archivedAt: 2 } },
    });

    const r = purgePhysical(home, 'session-' + ghost, 'parent');
    assert.equal(r.skipped.length, 0);
    assert.equal(r.dirs.length, 2, '两种拼写的目录都应删除');
    assert.equal(r.files.length, 1, '幽灵自己的 projcache 文件应删除');
    assert.equal(r.catalogRemoved, 1, '父 catalog 里 1 条引用应移除');
    assert.equal(r.archived, 1);
    assert.equal(r.members, 1);
    assert.equal(r.ledger, 1);

    // 磁盘断言
    assert.equal(existsSync(join(home, 'sessions', 'proj-a', ghost)), false);
    assert.equal(existsSync(join(home, 'sessions', 'proj-a', 'session-' + ghost)), false);
    const parent = readJson(join(home, 'storages', 'session_projcache', 'sessions', 'session-parent.json'));
    const vals = parent.record.rows.subagentCatalog.val.head.values;
    assert.deepEqual(vals.map((v) => v.childId), ['keep-1', 'session-other']);
    const wp = readJson(join(home, 'storages', 'workspace.json'));
    assert.deepEqual(wp.global.archivedSessionIds, ['session-keep']);
    assert.deepEqual(wp.tables.workspaces.w1.sessionIds, ['session-keep']);
    const lp = readJson(join(home, 'dsh-session-archive', 'archive-ledger.json'));
    assert.deepEqual(Object.keys(lp.entries), ['session-keep']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('purgePhysical 对空 DSH_HOME 安全返回空报告', () => {
  const r = purgePhysical('', 'abc');
  assert.equal(r.dirs.length, 0);
  assert.equal(r.catalogRemoved, 0);
});
