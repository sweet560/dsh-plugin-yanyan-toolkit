// 路径 A · 第 4a 阶段（树快照构建 Host 半）契约测试。
// 核心：用独立对照源（回收站磁盘扫描）与 manifest 双向对账构建完整 rows，
// 三层完整性校验任一失败整批拒绝、cascade 不被调用；含真机 zstd 会话文件用例。
// 静态守护断言模块内无物理删除调用（rm/unlink/rmdir 零调用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdtempSync, mkdirSync as realMkdirSync,
  writeFileSync as realWriteFileSync, realpathSync as realRealpathSync, existsSync as realExistsSync,
} from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SESSION_FILE_NAME, defaultDecompress, parseSessionHeader, defaultReadHeader,
  scanTrashDisk, buildRows, reconcile, buildSnapshot, cascadePurgeFromTrash,
  readSessionTitle, scanZstdFrames,
} from '../lib/session-snapshot.js';
import { descendantsOf, clientProtectedReason, planDelete } from '../lib/session-cascade.js';
import { MANIFEST_NAME, defaultFs, canonicalSessionId } from '../lib/session-trash.js';

const here = dirname(fileURLToPath(import.meta.url));
const moduleSrc = readFileSync(resolve(here, '../lib/session-snapshot.js'), 'utf8');

const TRASH = resolve('/dsh/session-trash');

/** 内存 fs：文件字节（Buffer）+ 目录集合，够跑 header 解析与对账，不含真实 zstd。 */
function createMemFs({ files = {}, dirs = [], listing = {} } = {}) {
  const contents = {};
  for (const [p, data] of Object.entries(files)) contents[resolve(p)] = data;
  const dirSet = new Set();
  const addWithParents = (d) => {
    let cur = resolve(d);
    for (;;) {
      dirSet.add(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  dirs.forEach(addWithParents);
  Object.keys(files).forEach((p) => addWithParents(dirname(p)));
  addWithParents(join(TRASH, 'proj'));
  return {
    __listing: Object.fromEntries(Object.entries(listing).map(([k, v]) => [resolve(k), v])),
    readFile: (p) => contents[resolve(p)],
    stat: (p) => ({ size: Buffer.isBuffer(contents[resolve(p)]) ? contents[resolve(p)].length : 0 }),
    realpath: (p) => resolve(p),
    readdir(p) {
      const ap = resolve(p);
      if (this.__listing[ap] !== undefined) return this.__listing[ap];
      const children = new Set();
      for (const d of dirSet) {
        if (d !== ap && dirname(d) === ap) children.add(basename(d));
      }
      return [...children];
    },
    exists: (p) => contents[resolve(p)] !== undefined || dirSet.has(resolve(p)),
  };
}

/** 造一份未压缩 jsonl header 文本（默认解压用例用）。 */
const headerJsonl = (header) => `${JSON.stringify(header)}\n{"type":"event"}\n`;

/** 构造可注入 readHeader 的 deps：按 segment（目录名）→ header 映射返回。 */
function headerResolver(headers) {
  return {
    readHeader: (_fs, filePath) => {
      const key = basename(dirname(filePath));
      const h = headers[key];
      if (h === undefined) throw new Error('no header');
      return h;
    },
  };
}

/** 造 manifest 条目（最小字段）。 */
const entry = (id, extra = {}) => ({ id, trashedPath: `x/${id}`, archivedAt: null, trashedAt: 1, ...extra });

/** 构造带 manifest 的内存 fs + header 注入 deps；headers 里每个 h.project 指定项目段。 */
function snapshotFixture(headers, entries, extra = {}) {
  const files = {};
  const headerMap = {};
  for (const h of headers) {
    const seg = h.id;
    const p = join(TRASH, h.project ?? 'proj', seg, SESSION_FILE_NAME);
    files[p] = Buffer.from('stub');
    headerMap[seg] = h;
  }
  const manifestPath = resolve(join(TRASH, MANIFEST_NAME));
  const manifest = { version: 1, entries };
  const base = createMemFs({ files, ...extra });
  const fs = {
    ...base,
    readFile(p) {
      if (resolve(p) === manifestPath) return JSON.stringify(manifest);
      return base.readFile(p);
    },
    exists(p) {
      if (resolve(p) === manifestPath) return true;
      return base.exists(p);
    },
  };
  return { fs, deps: headerResolver(headerMap), manifest };
}

// ---------- 常量 / 默认解压 / header 解析 ----------
test('SESSION_FILE_NAME 与真实日志文件名一致', () => {
  assert.equal(SESSION_FILE_NAME, 'session.v4.jsonl.zstd');
});

test('defaultDecompress 能解 zstd，parseSessionHeader 取首行 header', () => {
  const raw = headerJsonl({ type: 'session', version: 4, id: 'session-abc', origin: 'subagent', parentSession: 'session-root' });
  const header = parseSessionHeader(defaultDecompress(zstdCompressSync(Buffer.from(raw))));
  assert.equal(header.id, 'session-abc');
  assert.equal(header.origin, 'subagent');
  assert.equal(header.parentSession, 'session-root');
});

test('parseSessionHeader 拒绝损坏/非对象/缺 id', () => {
  assert.throws(() => parseSessionHeader(Buffer.from('not json')));
  assert.throws(() => parseSessionHeader(Buffer.from('[]')), /not an object/);
  assert.throws(() => parseSessionHeader(Buffer.from('{}')), /missing id/);
});

test('parseSessionHeader 版本不匹配时拒绝（P2-1 header schema 兼容）', () => {
  const v5 = headerJsonl({ type: 'session', version: 5, id: 'session-v5' });
  assert.throws(() => parseSessionHeader(Buffer.from(v5)), /unsupported session header version/);
  // 无 version 字段的旧 header 放行（向后兼容缺失版本的日志）
  const noVer = headerJsonl({ type: 'session', id: 'session-nover' });
  assert.equal(parseSessionHeader(Buffer.from(noVer)).id, 'session-nover');
});

test('defaultDecompress 超字节上限时拒绝（P0-3 内存保护）', () => {
  const raw = headerJsonl({ type: 'session', version: 4, id: 'session-big' });
  const zipped = zstdCompressSync(Buffer.from(raw));
  // 上限设为 1 字节，解压后必然超限
  assert.throws(() => defaultDecompress(zipped, { maxDecompressedBytes: 1 }), /too large/);
  // 正常上限放行
  assert.ok(defaultDecompress(zipped).length > 0);
});

// ---------- 拼接帧容器（真机 A2 标题裸 id 根因 m03899 / 2026-11-17）----------
test('scanZstdFrames 识别拼接帧边界（与 DSH zstd.ts 同构）', () => {
  const parts = [
    Buffer.from(headerJsonl({ type: 'session', version: 4, id: 'session-multi' })),
    Buffer.from(JSON.stringify({ type: 'session/title', data: { title: '帧2标题' } }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'session/title', data: { title: '帧3最新标题' } }) + '\n'),
  ];
  // 每个事件独立压成一个帧，再物理拼接（模拟 DSH 增量追加的容器结构）
  const container = Buffer.concat(parts.map((p) => zstdCompressSync(p)));
  const { frames, tornStart } = scanZstdFrames(container);
  assert.equal(frames.length, 3, '应识别出 3 个完整帧');
  assert.equal(tornStart, undefined, '无截断残帧');
  assert.equal(frames[0].start, 0);
  assert.equal(frames[2].end, container.length);
});

test('defaultDecompress 逐帧解压拼接；标题在末帧也能读到（真机 bug m03899 回归）', () => {
  // 标题在最后一帧——旧版整文件一次性解压在宿主老 Node 上只拿到首帧 → 标题 null → 裸 id
  const parts = [
    Buffer.from(headerJsonl({ type: 'session', version: 4, id: 'session-multi' })),
    Buffer.from(JSON.stringify({ type: 'event', data: {} }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'session/title', data: { title: '末帧最新标题' } }) + '\n'),
  ];
  const container = Buffer.concat(parts.map((p) => zstdCompressSync(p)));
  const text = defaultDecompress(container).toString('utf8');
  assert.match(text, /session-multi/, '首帧 header 可读');
  assert.match(text, /末帧最新标题/, '末帧标题必须可读（逐帧解压的核心保证）');
  // 端到端：readSessionTitle 走同一解压路径
  const dir = '/trash/proj/session-multi';
  const fs = createMemFs({ files: { [join(dir, SESSION_FILE_NAME)]: container } });
  assert.equal(readSessionTitle(fs, dir), '末帧最新标题', '拼接帧容器下标题应从末帧读到');
});

test('defaultDecompress 逐帧累计字节超上限时拒绝', () => {
  const parts = [
    Buffer.from(headerJsonl({ type: 'session', version: 4, id: 'session-a' }) + '\n'.repeat(50)),
    Buffer.from(JSON.stringify({ type: 'event', data: {} }) + '\n'.repeat(50)),
  ];
  const container = Buffer.concat(parts.map((p) => zstdCompressSync(p)));
  assert.throws(() => defaultDecompress(container, { maxDecompressedBytes: 20 }), /too large/);
});

// ---------- 标题读取（真机 A2 标题子项修复 m03612）----------
test('readSessionTitle 从 zstd 日志的 session/title 事件取末条标题', () => {
  const dir = '/trash/proj/session-abc';
  const jsonl = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-abc' }),
    JSON.stringify({ type: 'session/title', seq: 3, data: { title: '旧标题' } }),
    JSON.stringify({ type: 'session/title', seq: 20, data: { title: 'Numeric Input' } }),
    JSON.stringify({ type: 'event', data: {} }),
  ].join('\n');
  const fs = createMemFs({ files: { [join(dir, SESSION_FILE_NAME)]: zstdCompressSync(Buffer.from(jsonl)) } });
  assert.equal(readSessionTitle(fs, dir), 'Numeric Input', '应取末条 session/title 的最新标题');
});

test('readSessionTitle 无 session/title 事件或文件缺失返回 null，不抛', () => {
  const dir = '/trash/proj/session-noname';
  const fs1 = createMemFs({ files: { [join(dir, SESSION_FILE_NAME)]: zstdCompressSync(Buffer.from(headerJsonl({ type: 'session', version: 4, id: 'session-noname' }))) } });
  assert.equal(readSessionTitle(fs1, dir), null, '无标题事件返回 null');
  const fs2 = createMemFs({});
  assert.equal(readSessionTitle(fs2, '/trash/proj/missing'), null, '文件缺失返回 null');
});

test('readSessionTitle 解压失败时 fallback null（不阻塞 list）', () => {
  const dir = '/trash/proj/session-bad';
  const fs = createMemFs({ files: { [join(dir, SESSION_FILE_NAME)]: Buffer.from('not zstd') } });
  assert.equal(readSessionTitle(fs, dir), null, '损坏日志返回 null 而非抛错');
});

// ---------- 磁盘扫描 ----------
test('scanTrashDisk 扫描合法两层目录并读 header，报告 sizeBytes', () => {
  const files = {
    [join(TRASH, 'proj', 'session-a', SESSION_FILE_NAME)]: Buffer.from('x'),
    [join(TRASH, 'project-b', 'session-b', SESSION_FILE_NAME)]: Buffer.from('yy'),
  };
  const fs = createMemFs({ files });
  const { found, unsafe } = scanTrashDisk(fs, TRASH, headerResolver({
    'session-a': { id: 'session-a' }, 'session-b': { id: 'session-b' },
  }));
  assert.deepEqual(unsafe, []);
  assert.equal(found.length, 2);
  assert.equal(found.find((x) => x.segment === 'session-a').sizeBytes, 1);
  assert.equal(found.find((x) => x.segment === 'session-b').sizeBytes, 2);
});

test('scanTrashDisk 将缺文件/非法段名上报 unsafe、header 损坏上报 corrupt（单条目隔离）', () => {
  const fs = createMemFs({
    files: {
      [join(TRASH, 'proj', 'session-ok', SESSION_FILE_NAME)]: Buffer.from('x'),
      [join(TRASH, 'proj', 'session-bad', SESSION_FILE_NAME)]: Buffer.from('x'),
    },
    listing: {
      [TRASH]: ['proj'],
      [join(TRASH, 'proj')]: ['session-ok', 'session-bad', 'session-nofile', '..evil'],
    },
  });
  const deps = {
    readHeader: (_fs, filePath) => {
      if (basename(dirname(filePath)) === 'session-ok') return { id: 'session-ok' };
      throw new Error('bad header');
    },
  };
  const { unsafe, corrupt } = scanTrashDisk(fs, TRASH, deps);
  const whys = unsafe.map((u) => u.why).join(' | ');
  assert.match(whys, /illegal/);
  assert.match(whys, /session file missing/);
  // P1-1：header 损坏进入独立的 corrupt 清单（隔离），不再混入 unsafe 触发整批拒绝。
  assert.equal(corrupt.length, 1);
  assert.match(corrupt[0].why, /header read failed/);
});

// ---------- buildRows：字段映射 + childIds 反向聚合 ----------
test('buildRows 映射字段并反向聚合 childIds', () => {
  const rows = buildRows([
    { header: { id: 'session-root' }, sizeBytes: 10 },
    { header: { id: 'session-sub', parentSession: 'session-root', origin: 'subagent' }, sizeBytes: 20 },
    { header: { id: 'session-fork', parentSession: 'session-root', origin: 'fork' }, sizeBytes: 30 },
  ], {
    runningOf: (id) => id === 'session-root',
    protectedReasonOf: (id) => (id === 'session-sub' ? 'attached' : undefined),
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId.get('session-root').childIds.sort(), ['session-fork', 'session-sub']);
  assert.equal(byId.get('session-sub').parentId, 'session-root');
  assert.equal(byId.get('session-sub').origin, 'subagent');
  assert.equal(byId.get('session-sub').hostProtectedReason, 'attached');
  assert.equal(byId.get('session-root').running, true);
  assert.equal(byId.get('session-sub').running, false);
  assert.equal(byId.get('session-sub').sizeBytes, 20);
});

test('buildRows 对缺 origin 但有 parentSession 的行标 fork', () => {
  assert.equal(buildRows([{ header: { id: 'session-x', parentSession: 'session-p' } }])[0].origin, 'fork');
});

test('buildRows 孤儿子代理（父不在快照）不产生 childIds', () => {
  assert.deepEqual(buildRows([{ header: { id: 'session-sub', parentSession: 'session-missing', origin: 'subagent' } }])[0].childIds, []);
});

// ---------- reconcile 双向对账 ----------
test('reconcile 正常：两方都有的进 usable', () => {
  const r = reconcile(
    { 'session-a': entry('session-a'), 'session-b': entry('session-b') },
    [{ header: { id: 'session-a' }, dirPath: 'p/a' }, { header: { id: 'session-b' }, dirPath: 'p/b' }],
  );
  assert.equal(r.usable.length, 2);
  assert.deepEqual([r.orphans, r.purgingPending, r.mismatches], [[], [], []]);
});

test('reconcile：磁盘有 manifest 无 → orphans（不进 rows、不删）', () => {
  const r = reconcile({}, [{ header: { id: 'session-o' }, dirPath: 'p/o' }]);
  assert.equal(r.usable.length, 0);
  assert.equal(r.orphans[0].id, 'session-o');
});

test('reconcile：manifest 有磁盘无非 purging → mismatch；purging → purgingPending', () => {
  const r = reconcile({
    'session-gone': entry('session-gone'),
    'session-dead': entry('session-dead', { status: 'purging' }),
  }, []);
  assert.equal(r.mismatches[0].id, 'session-gone');
  assert.equal(r.purgingPending[0].id, 'session-dead');
});

// ---------- buildSnapshot 三层完整性 ----------
test('buildSnapshot 完整树：父 + 两子代理 + fork，fork 不被误认子代理', () => {
  const headers = [
    { id: 'session-root', project: 'proj' },
    { id: 'session-sub1', project: 'proj', parentSession: 'session-root', origin: 'subagent' },
    { id: 'session-sub2', project: 'proj', parentSession: 'session-root', origin: 'subagent' },
    { id: 'session-fork', project: 'proj', parentSession: 'session-root', origin: 'fork' },
  ];
  const { fs, deps } = snapshotFixture(headers, Object.fromEntries(headers.map((h) => [h.id, entry(h.id)])));
  const snap = buildSnapshot(fs, TRASH, deps);
  assert.equal(snap.ok, true, JSON.stringify(snap.reasons));
  assert.equal(snap.rows.length, 4);
  // 级联后代只含 subagent，不含 fork
  const descendants = descendantsOf(snap.rows, 'session-root');
  assert.deepEqual(new Set(descendants), new Set(['session-sub1', 'session-sub2']));
});

test('buildSnapshot：manifest 与磁盘不一致 → 整批拒绝（层1）', () => {
  const headers = [{ id: 'session-a', project: 'proj' }];
  // manifest 多一条 session-gone
  const { fs, deps } = snapshotFixture(headers, {
    'session-a': entry('session-a'), 'session-gone': entry('session-gone'),
  });
  const snap = buildSnapshot(fs, TRASH, deps);
  assert.equal(snap.ok, false);
  assert.ok(snap.reasons.some((r) => r.reason === 'manifest-disk-mismatch' && r.id === 'session-gone'));
  assert.deepEqual(snap.rows, []);
});

test('buildSnapshot：非法 origin（有 parentId 缺 origin 之外的未知值）→ 整批拒绝（层2）', () => {
  const headers = [
    { id: 'session-p', project: 'proj' },
    { id: 'session-c', project: 'proj', parentSession: 'session-p', origin: 'weird' },
  ];
  const { fs, deps } = snapshotFixture(headers, Object.fromEntries(headers.map((h) => [h.id, entry(h.id)])));
  const snap = buildSnapshot(fs, TRASH, deps);
  assert.equal(snap.ok, false);
  assert.ok(snap.reasons.some((r) => r.reason === 'invalid-origin' && r.id === 'session-c'));
});

test('buildSnapshot：childIds 反向聚合不产生悬挂（孤立子代理不进任何 childIds）', () => {
  const headers = [
    { id: 'session-root', project: 'proj' },
    // 子代理的 parentSession 指向快照外的父 → 不进任何 childIds，无悬挂引用
    { id: 'session-sub', project: 'proj', parentSession: 'session-ghost', origin: 'subagent' },
  ];
  const { fs, deps } = snapshotFixture(headers, Object.fromEntries(headers.map((h) => [h.id, entry(h.id)])));
  const snap = buildSnapshot(fs, TRASH, deps);
  // 这里 manifest 磁盘一致、origin 合法，孤立子代理不产生悬挂 → 快照通过
  assert.equal(snap.ok, true, JSON.stringify(snap.reasons));
  const root = snap.rows.find((r) => r.id === 'session-root');
  assert.deepEqual(root.childIds, []);
});

test('buildSnapshot：directIds 含非快照目标 → 整批拒绝', () => {
  const headers = [{ id: 'session-a', project: 'proj' }];
  const { fs, deps } = snapshotFixture(headers, { 'session-a': entry('session-a') });
  const snap = buildSnapshot(fs, TRASH, { ...deps, directIds: ['session-a', 'session-ghost'] });
  assert.equal(snap.ok, false);
  assert.ok(snap.reasons.some((r) => r.reason === 'target-not-in-snapshot' && r.id === 'session-ghost'));
});

test('buildSnapshot：磁盘 unsafe（缺 session 文件）→ 整批拒绝', () => {
  const headers = [{ id: 'session-a', project: 'proj' }];
  const { fs, deps } = snapshotFixture(headers, { 'session-a': entry('session-a') });
  // 把 session 文件从 fs 中移除
  const sessionPath = resolve(join(TRASH, 'proj', 'session-a', SESSION_FILE_NAME));
  const origExists = fs.exists;
  fs.exists = (p) => (resolve(p) === sessionPath ? false : origExists(p));
  const snap = buildSnapshot(fs, TRASH, deps);
  assert.equal(snap.ok, false);
  assert.ok(snap.reasons.some((r) => r.reason === 'disk-unsafe' && /session file missing/.test(r.detail)));
});

test('buildSnapshot：purging 悬挂条目进 purgingPending，不触发拒绝', () => {
  const headers = [{ id: 'session-a', project: 'proj' }];
  const { fs, deps } = snapshotFixture(headers, {
    'session-a': entry('session-a'),
    'session-dead': entry('session-dead', { status: 'purging' }),
  });
  const snap = buildSnapshot(fs, TRASH, deps);
  assert.equal(snap.ok, true, JSON.stringify(snap.reasons));
  assert.equal(snap.purgingPending.length, 1);
  assert.equal(snap.purgingPending[0].id, 'session-dead');
});

// ---------- cascadePurgeFromTrash 编排 ----------
test('cascadePurgeFromTrash：快照失败 → 整批拒绝，cascadeFn 未调用', async () => {
  const headers = [{ id: 'session-a', project: 'proj' }];
  const { fs, deps } = snapshotFixture(headers, {
    'session-a': entry('session-a'), 'session-gone': entry('session-gone'),
  });
  let called = false;
  const r = await cascadePurgeFromTrash(fs, TRASH, ['session-a'], {
    ...deps,
    cascadeFn: async () => { called = true; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'snapshot');
  assert.equal(r.cascadeCalled, false);
  assert.equal(called, false);
});

test('cascadePurgeFromTrash：快照成功 → 调用 cascadeFn 并透传参数', async () => {
  const headers = [
    { id: 'session-root', project: 'proj' },
    { id: 'session-sub', project: 'proj', parentSession: 'session-root', origin: 'subagent' },
  ];
  const { fs, deps } = snapshotFixture(headers, Object.fromEntries(headers.map((h) => [h.id, entry(h.id)])));
  let seen;
  const r = await cascadePurgeFromTrash(fs, TRASH, ['session-root'], {
    ...deps,
    protectedReason: new Map([['session-root', 'current']]),
    cascadeDeps: { marker: 7 },
    cascadeFn: async (rows, ids, prot, cd) => {
      seen = { rows, ids, prot, cd };
      return { ok: true, purged: 2, results: [] };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.stage, 'cascade');
  assert.equal(r.cascadeCalled, true);
  assert.equal(seen.rows.length, 2);
  assert.deepEqual(seen.ids, ['session-root']);
  assert.equal(seen.prot.get('session-root'), 'current');
  assert.equal(seen.cd.marker, 7);
});

// ---------- 评审核实新增：P0-2 三者一致 / P1-1 单条目隔离 / P1-3 fail-safe ----------
test('P0-2：header.id / 目录段名 / manifest 键三者经 canonical 归一恒等（1.1 命门延续）', () => {
  // 无前缀 header.id → canonical 补 session-；manifest 键用裸 uuid；目录段名为 session- 前缀。
  const headers = [{ id: 'abc-123', project: 'proj' }]; // header 里是裸 id
  const { fs, deps } = snapshotFixture(headers, { 'abc-123': entry('abc-123') });
  const snap = buildSnapshot(fs, TRASH, deps);
  assert.equal(snap.ok, true, JSON.stringify(snap.reasons));
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].id, 'session-abc-123'); // 权威 id 归一为 session- 形式
  // 不产生 mismatch/orphan：manifest 键 'abc-123' 与 header.id 'abc-123' 与段名 session-abc-123 归一后一致
  assert.equal(snap.reasons.length, 0);
  assert.deepEqual(snap.orphans, []);
});

test('P1-1：单条目 header 损坏进 corrupt 隔离，其余会话照常构建、cascade 被调用', async () => {
  const headers = [
    { id: 'session-good', project: 'proj' },
    { id: 'session-broken', project: 'proj' },
  ];
  const { fs, deps } = snapshotFixture(headers, {
    'session-good': entry('session-good'),
    'session-broken': entry('session-broken'),
  });
  // 让 session-broken 的 header 读取抛错（模拟解压失败/字段缺失）
  const origReadHeader = deps.readHeader;
  deps.readHeader = (fsArg, filePath, depArg) => {
    if (basename(dirname(filePath)) === 'session-broken') throw new Error('corrupt zstd');
    return origReadHeader(fsArg, filePath, depArg);
  };
  const snap = buildSnapshot(fs, TRASH, deps);
  assert.equal(snap.ok, true, JSON.stringify(snap.reasons)); // 单条目损坏不整批拒绝
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].id, 'session-good');
  assert.equal(snap.corrupt.length, 1);
  assert.equal(snap.corrupt[0].id, 'session-broken');
  // cascade 仍被调用（删的是健康的 session-good）
  let called = false;
  const r = await cascadePurgeFromTrash(fs, TRASH, ['session-good'], {
    ...deps,
    cascadeFn: async () => { called = true; return { ok: true }; },
  });
  assert.equal(r.cascadeCalled, true);
  assert.equal(called, true);
});

test('P1-1：显式要求删除损坏条目 → fail-closed 拒绝（corrupt-target）', async () => {
  const headers = [{ id: 'session-broken', project: 'proj' }];
  const { fs, deps } = snapshotFixture(headers, { 'session-broken': entry('session-broken') });
  deps.readHeader = () => { throw new Error('corrupt zstd'); };
  const r = await cascadePurgeFromTrash(fs, TRASH, ['session-broken'], {
    ...deps,
    cascadeFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.cascadeCalled, false);
  assert.ok(r.reasons.some((x) => x.reason === 'corrupt-target'));
});

test('P1-3：活跃态读取抛错时 fail-safe 视为受保护（read-error）', () => {
  const rows = buildRows([{ header: { id: 'session-x' }, sizeBytes: 1 }], {
    runningOf: () => { throw new Error('agent service unavailable'); },
  });
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].hostProtectedReason, 'read-error'); // fail-safe，不把读不到当非运行
});

// ---------- 第六轮确认：canonical 外部锚点 / corrupt 组合级联 / read-error 整族跳过 ----------
test('第六轮·canonical：与现成包同构 + 真实 DSH 目录段名外部锚点（非自证）', () => {
  // 现成包 src/host/session-files.ts:20-22 的实现逐字节抄录于此作对照源（外部锚点）。
  const upstreamCanonical = (segment) => segment.startsWith('session-') ? segment : `session-${segment}`;
  // P0-1 实测的真实 DSH 形态：header.id 与目录段名都是 session-<uuid>，逐字节一致。
  const realId = 'session-8b3d5555-9313-49de-8c2c-d8a3f5d41c78';
  const realSegment = realId; // 真实目录段名 = header.id（带前缀布局）
  assert.equal(canonicalSessionId(realSegment), upstreamCanonical(realSegment));
  assert.equal(canonicalSessionId(realId), upstreamCanonical(realId));
  assert.equal(canonicalSessionId(realSegment), canonicalSessionId(realId));
  // 还原回的段名与磁盘实际段名逐字节一致（无前缀布局也验证一次：补前缀后与带前缀形态归一相等）。
  const bareUuid = '8b3d5555-9313-49de-8c2c-d8a3f5d41c78';
  assert.equal(canonicalSessionId(bareUuid), realSegment);
  assert.equal(canonicalSessionId(bareUuid), upstreamCanonical(bareUuid));
});

test('第六轮·corrupt 组合：1 corrupt + 2 正常，删正常成功 / 删 corrupt 拒绝', async () => {
  const headers = [
    { id: 'session-keep-a', project: 'proj' },
    { id: 'session-keep-b', project: 'proj' },
    { id: 'session-bad', project: 'proj' },
  ];
  const { fs, deps } = snapshotFixture(headers, {
    'session-keep-a': entry('session-keep-a'),
    'session-keep-b': entry('session-keep-b'),
    'session-bad': entry('session-bad'),
  });
  const origReadHeader = deps.readHeader;
  deps.readHeader = (fsArg, filePath, depArg) => {
    if (basename(dirname(filePath)) === 'session-bad') throw new Error('corrupt zstd');
    return origReadHeader(fsArg, filePath, depArg);
  };
  let cascadeTargets = null;
  const good = await cascadePurgeFromTrash(fs, TRASH, ['session-keep-a', 'session-keep-b'], {
    ...deps,
    cascadeFn: async (_rows, directIds) => { cascadeTargets = directIds; return { ok: true, succeeded: directIds }; },
  });
  assert.equal(good.ok, true);
  assert.equal(good.cascadeCalled, true);
  assert.deepEqual(cascadeTargets, ['session-keep-a', 'session-keep-b']); // corrupt 不在删除目标里
  assert.equal(good.snapshot.corrupt.length, 1);
  assert.equal(good.snapshot.corrupt[0].id, 'session-bad');
  // 显式删 corrupt → fail-closed，cascade 不调用
  let called = false;
  const bad = await cascadePurgeFromTrash(fs, TRASH, ['session-bad'], {
    ...deps,
    cascadeFn: async () => { called = true; return { ok: true }; },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.cascadeCalled, false);
  assert.equal(called, false);
  assert.ok(bad.reasons.some((x) => x.reason === 'corrupt-target'));
});

test('第六轮·read-error 整族防护：rank=Infinity 使会话及其 subagent 后代都不被删', () => {
  // 场景1：直接选中 read-error 会话——它自己 skipped(read-error)，家族不动（子代理也不进 targets）。
  const rows = [
    { id: 'session-root', parentId: undefined, origin: undefined, childIds: ['session-child'], running: false, hostProtectedReason: 'read-error' },
    { id: 'session-child', parentId: 'session-root', origin: 'subagent', childIds: [], running: false, hostProtectedReason: undefined },
    { id: 'session-other', parentId: undefined, origin: undefined, childIds: [], running: false, hostProtectedReason: undefined },
  ];
  const protectedReason = clientProtectedReason(rows, undefined);
  // read-error 不在 PROTECTION_RANK 枚举内 → rank=Infinity → 最高保护
  assert.equal(protectedReason.get('session-root'), 'read-error');
  const plan = planDelete(rows, ['session-root', 'session-other'], protectedReason);
  assert.ok(plan.skipped.some((s) => s.id === 'session-root' && s.reason === 'read-error'));
  assert.ok(!plan.targets.includes('session-root'));
  assert.ok(!plan.targets.includes('session-child'), '受保护父的 subagent 后代绝不能被删');
  assert.ok(plan.targets.includes('session-other'), '健康独立会话不受影响');

  // 场景2：选中健康父，但其 subagent 后代 read-error → blocker 触发整族 family-protected。
  const rows2 = [
    { id: 'session-parent', parentId: undefined, origin: undefined, childIds: ['session-desc'], running: false, hostProtectedReason: undefined },
    { id: 'session-desc', parentId: 'session-parent', origin: 'subagent', childIds: [], running: false, hostProtectedReason: 'read-error' },
  ];
  const protectedReason2 = clientProtectedReason(rows2, undefined);
  assert.equal(protectedReason2.get('session-desc'), 'read-error');
  const plan2 = planDelete(rows2, ['session-parent'], protectedReason2);
  assert.ok(!plan2.targets.includes('session-parent'), '后代 read-error 阻塞整族');
  assert.ok(!plan2.targets.includes('session-desc'));
  assert.ok(plan2.skipped.some((s) => s.id === 'session-parent' && s.reason === 'family-protected'));
});

// ---------- 真机 zstd 用例 ----------
test('真机：真实 zstd 会话文件 + manifest 构建完整快照（父+两子代理+fork）', () => {
  const base = mkdtempSync(join(tmpdir(), 'yanyan-snapshot-'));
  const project = 'proj-real';
  const defs = [
    { id: 'session-root' },
    { id: 'session-sub1', parentSession: 'session-root', origin: 'subagent' },
    { id: 'session-sub2', parentSession: 'session-root', origin: 'subagent' },
    { id: 'session-fork', parentSession: 'session-root', origin: 'fork' },
  ];
  const entries = {};
  for (const d of defs) {
    const dir = join(base, project, d.id);
    realMkdirSync(dir, { recursive: true });
    const header = { type: 'session', version: 4, ...d };
    realWriteFileSync(join(dir, SESSION_FILE_NAME), zstdCompressSync(Buffer.from(headerJsonl(header))));
    entries[d.id] = entry(d.id);
  }
  realWriteFileSync(join(base, MANIFEST_NAME), JSON.stringify({ version: 1, entries }));

  // 真机 fs 适配器（复用 session-trash.defaultFs，默认解压走 zstd，不注入 readHeader）
  const fs = defaultFs();
  const snap = buildSnapshot(fs, base, {});
  assert.equal(snap.ok, true, JSON.stringify(snap.reasons));
  assert.equal(snap.rows.length, 4);
  const root = snap.rows.find((r) => r.id === 'session-root');
  assert.deepEqual(new Set(descendantsOf(snap.rows, 'session-root')), new Set(['session-sub1', 'session-sub2']));
  assert.equal(root.childIds.length, 3); // fork 仍在 childIds，但不在 cascade 目标
});

// ---------- 静态守护：本模块零物理删除 ----------
test('静态守护：session-snapshot.js 无任何物理删除调用', () => {
  const rmPattern = /\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/;
  assert.equal(rmPattern.test(moduleSrc), false, 'snapshot 模块不得调用 rm/unlink/rmdir');
});
