// 路径 A · 第 2 阶段（回收站物理删除管线）契约测试。
// 内存 fs 适配器（带可注入 rm）覆盖逻辑分支；另含真机 fs 用例覆盖真实 rm。
// 静态守护：session-purge.js 的 rm 调用必须来自经 assertSafeTarget 校验后的 realPath，
// 且 rm 必须在 withManifestLock 回调之外执行（决策点 3 的锁边界）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdtempSync, mkdirSync as realMkdirSync,
  writeFileSync as realWriteFileSync, existsSync as realExistsSync,
  rmSync as realRmSync, realpathSync as realRealpathSync,
  renameSync as realRenameSync, readdirSync as realReaddirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TRASH_ROOT_NAME, MANIFEST_NAME, MANIFEST_VERSION,
  canonicalSessionId, readManifest, writeManifest, withManifestLock,
} from '../lib/session-trash.js';
import {
  DEFAULT_RETENTION_MS, PURGED_EVENT, RETRYABLE_RM_CODES,
  makePurgeFs, rmWithRetry, preflightPurge, purge, purgeExpired, recoverPurging,
} from '../lib/session-purge.js';

const here = dirname(fileURLToPath(import.meta.url));
const SESSIONS = resolve('/dsh/sessions');
const TRASH = resolve('/dsh/session-trash');

/**
 * 内存 fs：目录集合 + 文件内容 + 可注入 rm 行为。
 * dirs 里每个目录连同祖先加入 dirSet（对齐 session-trash 测试的 addWithParents）。
 */
function createMemFs({ dirs = [], rmError = null, rmErrorQueue = [] } = {}) {
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
  const fileSet = new Set();
  const contents = {};
  const rmCalls = [];
  let errCursor = 0;
  const fs = {
    __sessionsRoot: SESSIONS,
    __trashRoot: TRASH,
    lstat(p) {
      const ap = resolve(p);
      return {
        isSymbolicLink: () => false,
        isDirectory: () => dirSet.has(ap),
      };
    },
    realpath: (p) => resolve(p),
    stat: () => ({ dev: 1 }),
    rename(from, to) {
      const af = resolve(from);
      const at = resolve(to);
      if (contents[af] !== undefined) {
        contents[at] = contents[af];
        delete contents[af];
        fileSet.add(at);
        fileSet.delete(af);
      }
      dirSet.delete(af);
      addWithParents(at);
    },
    mkdir: (p) => addWithParents(p),
    readFile: (p) => contents[resolve(p)],
    writeFile(p, data) {
      fileSet.add(resolve(p));
      contents[resolve(p)] = data;
    },
    readdir(p) {
      const ap = resolve(p);
      const explicit = fs.__listing?.[ap];
      if (explicit !== undefined) return explicit;
      const children = new Set();
      for (const d of dirSet) {
        if (d === ap) continue;
        if (dirname(d) === ap) children.add(basename(d));
      }
      return [...children];
    },
    exists: (p) => {
      const ap = resolve(p);
      return dirSet.has(ap) || fileSet.has(ap);
    },
    rm(p, opts) {
      rmCalls.push({ path: resolve(p), opts });
      // 错误注入：队列逐条消耗，否则用固定 rmError。
      let err = null;
      if (errCursor < rmErrorQueue.length) err = rmErrorQueue[errCursor];
      else err = rmError;
      errCursor += 1;
      if (err) throw err;
      const ap = resolve(p);
      // 递归删除该目录及其子目录/文件。
      for (const d of [...dirSet]) if (d === ap || d.startsWith(ap + '/')) dirSet.delete(d);
      for (const f of [...fileSet]) if (f.startsWith(ap + '/')) { fileSet.delete(f); delete contents[f]; }
      return undefined;
    },
    __dirSet: dirSet,
    __fileSet: fileSet,
    __contents: contents,
    __rmCalls: rmCalls,
    __listing: {},
  };
  return fs;
}

/** 造一个「已在回收站、状态有效」的条目 + manifest。 */
function seedTrashed(fs, { id = 'session-abc', project = 'proj-a', segment = 'session-abc', status } = {}) {
  const dir = join(TRASH, project, segment);
  addDir(fs, dir);
  const manifest = { version: MANIFEST_VERSION, entries: {}, quarantined: [] };
  const entry = {
    id: canonicalSessionId(id),
    originalPath: join(SESSIONS, project, segment),
    trashedPath: dir,
    trashedAt: 1000,
    deletedAt: 1000,
    ...(status ? { status } : {}),
  };
  manifest.entries[entry.id] = entry;
  writeManifest(fs, TRASH, manifest);
  return { entry, dir, canonical: entry.id };
}
function addDir(fs, d) {
  const ap = resolve(d);
  let cur = ap;
  for (;;) {
    fs.__dirSet.add(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}
function makeDeps(fs, overrides = {}) {
  return {
    fs,
    trashRoot: TRASH,
    now: () => 2000,
    rmAttempts: 3,
    rmBaseDelayMs: 1,
    rmDelay: async () => {},
    emitPurged: overrides.emitPurged || (() => {}),
    ...overrides,
  };
}

// ---- 常量与基础原语 ----

test('常量：保留期默认 30 天、事件名、可重试错误码集合', () => {
  assert.equal(DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(PURGED_EVENT, 'api-session/purged');
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) assert.equal(RETRYABLE_RM_CODES.has(code), true);
  assert.equal(RETRYABLE_RM_CODES.has('ENOENT'), false);
});

test('makePurgeFs 为 fs 适配器补上 rm', () => {
  const base = createMemFs();
  delete base.rm;
  const purgeFs = makePurgeFs(base);
  assert.equal(typeof purgeFs.rm, 'function');
});

// ---- 1. 目标侧四层校验 + 风险边界（非 manifest 条目 / quarantined / restoring）----

test('preflightPurge 拒绝非 manifest 条目（风险边界：不得绕过回收站直删）', () => {
  const fs = createMemFs({ dirs: [TRASH] });
  writeManifest(fs, TRASH, { version: MANIFEST_VERSION, entries: {}, quarantined: [] });
  const plan = preflightPurge(['session-ghost'], makeDeps(fs));
  assert.equal(plan.ok, false);
  assert.match(plan.reasons[0].reason, /not in manifest/);
});

test('preflightPurge 拒绝 quarantined 条目（评审 1.2）', () => {
  const fs = createMemFs();
  seedTrashed(fs);
  const manifest = readManifest(fs, TRASH);
  manifest.quarantined = [{ project: 'proj-a', segment: 'session-abc', why: 'illegal' }];
  writeManifest(fs, TRASH, manifest);
  const plan = preflightPurge(['session-abc'], makeDeps(fs));
  assert.equal(plan.ok, false);
  assert.match(plan.reasons[0].reason, /quarantined/);
});

test('preflightPurge 拒绝 restoring 条目（二次复检拒绝）', () => {
  const fs = createMemFs();
  seedTrashed(fs, { status: 'restoring' });
  const plan = preflightPurge(['session-abc'], makeDeps(fs));
  assert.equal(plan.ok, false);
  assert.match(plan.reasons[0].reason, /restoring/);
});

test('preflightPurge 拒绝不在回收站、状态非 purging 的条目', () => {
  const fs = createMemFs();
  seedTrashed(fs);
  // 抹掉回收站目录但条目状态正常（非 purging）→ 拒绝
  fs.__dirSet.delete(resolve(join(TRASH, 'proj-a', 'session-abc')));
  const plan = preflightPurge(['session-abc'], makeDeps(fs));
  assert.equal(plan.ok, false);
  assert.match(plan.reasons[0].reason, /not found in trash/);
});

test('purge 目标侧四层校验：符号链接目标被 assertSafeTarget 拒绝', () => {
  const fs = createMemFs();
  seedTrashed(fs);
  const target = resolve(join(TRASH, 'proj-a', 'session-abc'));
  const origLstat = fs.lstat;
  fs.lstat = (p) => resolve(p) === target
    ? { isSymbolicLink: () => true, isDirectory: () => false }
    : origLstat(p);
  const plan = preflightPurge(['session-abc'], makeDeps(fs));
  assert.equal(plan.ok, false);
  assert.match(plan.reasons[0].reason, /symlink|unsafe/i);
});

// ---- 2. 整批 fail-closed ----

test('purge 整批 fail-closed：一条非法则全部不删', async () => {
  const fs = createMemFs();
  const good = seedTrashed(fs, { id: 'session-good', segment: 'session-good' });
  const emitted = [];
  const result = await purge(['session-good', 'session-ghost'], makeDeps(fs, { emitPurged: (id) => emitted.push(id) }));
  assert.equal(result.ok, false);
  assert.equal(result.purged, 0);
  assert.equal(result.rejected, 2);
  assert.equal(fs.__dirSet.has(resolve(good.dir)), true, 'good 条目目录不应被删');
  assert.equal(emitted.length, 0);
});

// ---- 3. 正常 purge 流程 + 决策点 1（空 project 保留）+ 决策点 3（锁边界）----

test('purge 正常删除：目录被 rm、条目移除、广播一次、project 目录保留', async () => {
  const fs = createMemFs();
  const { dir } = seedTrashed(fs);
  const emitted = [];
  const result = await purge(['session-abc'], makeDeps(fs, { emitPurged: (id) => emitted.push(id) }));
  assert.equal(result.ok, true, result.results[0]?.detail || '');
  assert.equal(result.purged, 1);
  assert.equal(fs.__dirSet.has(resolve(dir)), false, '会话目录应被 rm');
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj-a'))), true, '空 project 目录必须保留（决策点 1）');
  assert.equal(readManifest(fs, TRASH).entries['session-abc'], undefined);
  assert.deepEqual(emitted, ['session-abc']);
  assert.equal(fs.__rmCalls.length, 1);
});

test('purge rm 参数来自二次校验后的 realPath（运行时可追溯）', async () => {
  const fs = createMemFs();
  seedTrashed(fs);
  await purge(['session-abc'], makeDeps(fs));
  assert.equal(fs.__rmCalls.length, 1);
  assert.equal(fs.__rmCalls[0].path, resolve(join(TRASH, 'proj-a', 'session-abc')));
  assert.deepEqual(fs.__rmCalls[0].opts, { recursive: true, force: false });
});

// ---- 4. Windows EBUSY/EPERM 重试 ----

test('rmWithRetry：EBUSY 重试 2 次后成功', async () => {
  const err = Object.assign(new Error('busy'), { code: 'EBUSY' });
  const fs = createMemFs({ rmErrorQueue: [err, err] }); // 前两次忙，第三次成功
  const result = await rmWithRetry(resolve('/dsh/session-trash/proj-a/session-abc'), makeDeps(fs));
  assert.equal(result.removed, true);
  assert.equal(result.attempts, 3);
});

test('rmWithRetry：不可重试错误（ENOENT）立即失败，不重试', async () => {
  const err = Object.assign(new Error('gone'), { code: 'ENOENT' });
  const fs = createMemFs({ rmError: err });
  await assert.rejects(
    rmWithRetry(resolve('/dsh/session-trash/proj-a/session-abc'), makeDeps(fs)),
    (e) => e.code === 'ENOENT',
  );
  assert.equal(fs.__rmCalls.length, 1, '不可重试错误只尝试一次');
});

test('purge 单条重试耗尽：返回逐项错误码，条目保持 purging 供恢复', async () => {
  const err = Object.assign(new Error('locked'), { code: 'EBUSY' });
  const fs = createMemFs({ rmError: err });
  seedTrashed(fs);
  const result = await purge(['session-abc'], makeDeps(fs, { rmAttempts: 2 }));
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].reason, 'rm-failed');
  assert.equal(result.results[0].code, 'EBUSY');
  assert.equal(readManifest(fs, TRASH).entries['session-abc'].status, 'purging', '失败后应保持 purging');
});

// ---- 5. 原子写（复用底座）----

test('purge 的 manifest 更新走底座原子写：不留 .tmp、rename 覆盖', async () => {
  const fs = createMemFs();
  seedTrashed(fs);
  await purge(['session-abc'], makeDeps(fs));
  const temps = [...fs.__fileSet].filter((p) => p.includes('.tmp'));
  assert.deepEqual(temps, []);
  const m = readManifest(fs, TRASH);
  assert.equal(m.version, MANIFEST_VERSION);
  assert.deepEqual(m.entries, {});
});

// ---- 6. purging 两分支崩溃恢复 ----

test('recoverPurging 分支 B：purging 且目录不存在 → 仅移除条目，不调用 rm', async () => {
  const fs = createMemFs();
  seedTrashed(fs, { status: 'purging' });
  fs.__dirSet.delete(resolve(join(TRASH, 'proj-a', 'session-abc')));
  const result = await recoverPurging(makeDeps(fs));
  assert.equal(result.ok, true);
  assert.equal(result.purged, 1);
  assert.equal(result.results[0].recovery, 'purging-no-dir');
  assert.equal(fs.__rmCalls.length, 0, '目录不存在不应调用 rm');
  assert.equal(readManifest(fs, TRASH).entries['session-abc'], undefined);
});

test('recoverPurging 分支 A：purging 且目录存在 → 重试删除', async () => {
  const fs = createMemFs();
  seedTrashed(fs, { status: 'purging' });
  const result = await recoverPurging(makeDeps(fs));
  assert.equal(result.ok, true);
  assert.equal(result.purged, 1);
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj-a', 'session-abc'))), false);
  assert.equal(fs.__rmCalls.length, 1);
});

test('ENOENT 收敛：阶段2 rm 抛 ENOENT → 保持 purging → recover 见目录不存在仅移条目（P1）', async () => {
  // 场景：阶段 1 校验后、阶段 2 执行 rm 前，目录被外部清理/restore 搬走 → rm 命中旧路径 ENOENT。
  const fs = createMemFs();
  seedTrashed(fs);
  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
  // rm 在真正删除前先抛 ENOENT（模拟目录已在阶段 1 之后消失）。
  const origRm = fs.rm;
  fs.rm = (p, opts) => { throw gone; };
  const first = await purge(['session-abc'], makeDeps(fs));
  assert.equal(first.ok, false);
  assert.equal(first.results[0].reason, 'rm-failed');
  assert.equal(first.results[0].code, 'ENOENT', 'ENOENT 是不可重试码，逐项错误码如实返回');
  assert.equal(readManifest(fs, TRASH).entries['session-abc'].status, 'purging', '抛错后条目保持 purging');

  // 下一次启动恢复：此刻目录实际已不存在（模拟外部清理），recover 应走「仅移条目」分支、不调 rm。
  fs.__dirSet.delete(resolve(join(TRASH, 'proj-a', 'session-abc')));
  fs.rm = origRm;
  const rmCallsBeforeRecover = fs.__rmCalls.length;
  const recovered = await recoverPurging(makeDeps(fs));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.purged, 1);
  assert.equal(recovered.results[0].recovery, 'purging-no-dir');
  assert.equal(fs.__rmCalls.length, rmCallsBeforeRecover, 'recover 分支 B 不应再调用 rm');
  assert.equal(readManifest(fs, TRASH).entries['session-abc'], undefined, 'recover 后条目被移除');
});

test('rm 成功后 manifest 移除失败 → 条目保持 purging，restart 由 recoverPurging 收敛', async () => {
  const fs = createMemFs();
  seedTrashed(fs);
  const deps = makeDeps(fs);
  const origRm = fs.rm;
  const origWriteFile = fs.writeFile;
  fs.rm = (p, opts) => {
    const r = origRm(p, opts);
    // rm 成功后，让阶段 3 的 manifest 原子写抛错（模拟磁盘故障）。
    fs.writeFile = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    return r;
  };
  const result = await purge(['session-abc'], deps);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, 'manifest-remove-failed');
  assert.equal(readManifest(fs, TRASH).entries['session-abc'].status, 'purging');

  // P1（第三轮）：阶段 3 失败的收敛路径——目录已不存在（rm 已成功），条目仍 purging；
  // 恢复 fs 写入后跑 recover，应走分支 B（purging-no-dir）仅移条目、不调 rm。
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj-a', 'session-abc'))), false, '目录已被 rm');
  fs.writeFile = origWriteFile; // 还原，recover 的 manifest 写入才能成功
  const rmCallsBeforeRecover = fs.__rmCalls.length;
  const recovered = await recoverPurging(makeDeps(fs));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.purged, 1);
  assert.equal(recovered.results[0].recovery, 'purging-no-dir');
  assert.equal(fs.__rmCalls.length, rmCallsBeforeRecover, 'recover 分支 B 不应再调用 rm');
  assert.equal(readManifest(fs, TRASH).entries['session-abc'], undefined, '条目最终被收敛移除');
});

test('并发 purge 拒绝：第二个 purge 遇 purging 被拒，rm 只执行一次（P1 双向互斥另一半）', async () => {
  const fs = createMemFs();
  seedTrashed(fs);
  const first = await purge(['session-abc'], makeDeps(fs));
  assert.equal(first.ok, true);
  const rmAfterFirst = fs.__rmCalls.length;
  assert.ok(rmAfterFirst >= 1);

  // 重新播下一个 purging 条目（目录仍在），模拟并发的第二个 purge 进入阶段 1。
  seedTrashed(fs, { status: 'purging' });
  const rmBeforeSecond = fs.__rmCalls.length;
  const second = await purge(['session-abc'], makeDeps(fs));
  assert.equal(second.ok, false, '运行时并发 purge 应被拒绝');
  assert.equal(second.rejected, 1);
  assert.match(second.results[0].reason, /purging.*refusing to purge/);
  assert.equal(fs.__rmCalls.length, rmBeforeSecond, '被拒的 purge 不应执行任何 rm');
  // 但启动恢复路径（allowPurging）仍可处理同一 purging 条目。
  const recovered = await recoverPurging(makeDeps(fs));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.purged, 1);
});

// ---- 7. 保留期扫描 ----

test('purgeExpired：仅删除超过保留期的条目，两条路径共用同一校验', async () => {
  const fs = createMemFs();
  const old = seedTrashed(fs, { id: 'session-old', segment: 'session-old' });
  const freshManifest = readManifest(fs, TRASH);
  freshManifest.entries['session-fresh'] = {
    id: 'session-fresh', trashedPath: join(TRASH, 'proj-a', 'session-fresh'),
    originalPath: join(SESSIONS, 'proj-a', 'session-fresh'), trashedAt: 1800, deletedAt: 1800,
  };
  addDir(fs, join(TRASH, 'proj-a', 'session-fresh'));
  writeManifest(fs, TRASH, freshManifest);
  const result = await purgeExpired(makeDeps(fs, { retentionMs: 500, now: () => 2000 }));
  assert.equal(result.ok, true, result.results?.[0]?.detail || '');
  assert.equal(result.purged, 1);
  assert.equal(fs.__dirSet.has(resolve(old.dir)), false, '过期条目应被删');
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj-a', 'session-fresh'))), true, '未过期条目保留');
});

test('purgeExpired：无时间基准的条目被跳过（fail-safe）', async () => {
  const fs = createMemFs();
  const manifest = { version: MANIFEST_VERSION, entries: {
    'session-notime': { id: 'session-notime', trashedPath: join(TRASH, 'proj-a', 'session-notime') },
  }, quarantined: [] };
  addDir(fs, join(TRASH, 'proj-a', 'session-notime'));
  writeManifest(fs, TRASH, manifest);
  const result = await purgeExpired(makeDeps(fs, { retentionMs: 1, now: () => 999999 }));
  assert.equal(result.purged, 0);
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj-a', 'session-notime'))), true);
});

// ---- 8. 真机 fs：覆盖真实 rm ----

test('真机 fs：真实 rm 删除会话目录，project 目录保留', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-purge-test-'));
  const trash = join(base, TRASH_ROOT_NAME);
  const dir = join(trash, 'proj-a', 'session-abc');
  realMkdirSync(dir, { recursive: true });
  realWriteFileSync(join(dir, 'session.v4.jsonl.zstd'), 'data');
  const fs = makePurgeFs({
    __sessionsRoot: join(base, 'sessions'),
    __trashRoot: trash,
    lstat: (p) => ({ isSymbolicLink: () => false, isDirectory: () => realExistsSync(p) }),
    realpath: (p) => realRealpathSync(p),
    stat: () => ({ dev: 1 }),
    rename: (from, to) => realRenameSync(from, to),
    mkdir: (p, opts) => realMkdirSync(p, opts),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, d) => realWriteFileSync(p, d),
    readdir: (p) => realReaddirSync(p),
    exists: (p) => realExistsSync(p),
  });
  writeManifest(fs, trash, { version: MANIFEST_VERSION, entries: {
    'session-abc': {
      id: 'session-abc', trashedPath: dir,
      originalPath: join(base, 'sessions', 'proj-a', 'session-abc'), trashedAt: 1000,
    },
  }, quarantined: [] });
  const result = await purge(['session-abc'], {
    fs, trashRoot: trash, now: () => 2000, rmAttempts: 3, rmBaseDelayMs: 1, rmDelay: async () => {},
  });
  assert.equal(result.ok, true, result.results?.[0]?.detail || '');
  assert.equal(realExistsSync(dir), false, '真机目录应被删除');
  assert.equal(realExistsSync(join(trash, 'proj-a')), true, '空 project 目录保留');
  realRmSync(base, { recursive: true, force: true });
});

// ---- 9. 静态守护：rm 只在 assertSafeTarget 保护路径上、且锁外执行 ----

test('lib/session-purge.js 的 rm 参数可静态追溯到校验后的 realPath', () => {
  const src = readFileSync(join(here, '..', 'lib', 'session-purge.js'), 'utf8');
  // rm 调用只允许出现在 rmWithRetry 内，参数是 realPath（校验后变量）。
  assert.match(src, /fs\.rm\(realPath, \{ recursive: true, force: false \}\)/);
  const segment = src.slice(src.indexOf('async function purgeOne'), src.indexOf('/** 汇总逐条结果'));
  // purgeOne 内 rm 的输入必须来自 assertSafeTarget 的返回值。
  assert.match(segment, /assertSafeTarget\(id, marked\.current, trashRoot, fs\)/);
  assert.match(segment, /rmWithRetry\(recheck\.realPath, deps\)/);
  // 不得出现「未经校验直接 rm 任意路径」的字面写法。
  assert.doesNotMatch(segment, /fs\.rm\(/);
  // 锁边界（决策点 3）：阶段 1 的 withManifestLock 回调内不含 rmWithRetry / rm，
  // rmWithRetry 出现在标记锁之后的「阶段 2」段——证明 rm 在锁外执行。
  const markBlock = segment.slice(segment.indexOf('withManifestLock'), segment.indexOf('// ---- 阶段 2'));
  assert.doesNotMatch(markBlock, /rmWithRetry|fs\.rm/);
});
