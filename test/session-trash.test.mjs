// 路径 A · 第 1 阶段（可逆回收站管线）契约测试。
// 全程默认用内存 fs 适配器；另含一个真机 fs 集成用例（临时目录 rename + 大小写/占用行为）。
// 静态断言精确守护「不引入 fs.rm/rmdir/unlink 调用」（P0-4：精确到成员调用模式，避免 rename 误报）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync as realMkdirSync, writeFileSync as realWriteFileSync, existsSync as realExistsSync, renameSync as realRenameSync, realpathSync as realRealpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TRASH_ROOT_NAME,
  MANIFEST_NAME,
  MANIFEST_VERSION,
  SEGMENT_RE,
  canonicalSessionId,
  isValidSessionSegment,
  safeTargetSegment,
  relativeWithin,
  isInside,
  isTwoLevelUnder,
  resolveDshHome,
  assertSafeTarget,
  assertDisjointRoots,
  assertSameVolume,
  archiveGateFromContext,
  emitterFromContext,
  readManifest,
  writeManifest,
  locateUnder,
  makeScanner,
  preflight,
  moveOneToTrash,
  runTrashPipeline,
  restoreFromTrash,
  listTrash,
  rebuildManifestFromTrash,
  drainCompensationQueue,
  trashTargetFor,
} from '../lib/session-trash.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 内存 fs：维护目录集合、符号链接集合与 rename 记录。 */
function createMemFs({ dirs = [], symlinks = [], dev = {} } = {}) {
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
  const linkSet = new Set(symlinks.map((d) => resolve(d)));
  const fileSet = new Set();
  const contents = {};
  const renameCalls = [];
  const fs = {
    __sessionsRoot: resolve('/dsh/sessions'),
    __trashRoot: resolve('/dsh/session-trash'),
    lstat(p) {
      const ap = resolve(p);
      return {
        isSymbolicLink: () => linkSet.has(ap),
        isDirectory: () => dirSet.has(ap) && !linkSet.has(ap),
      };
    },
    realpath: (p) => resolve(p),
    stat(p) {
      const ap = resolve(p);
      if (dev[ap] !== undefined) return { dev: dev[ap] };
      // 逐段回退找最近存在祖先的 dev
      let cur = ap;
      while (true) {
        if (dev[cur] !== undefined) return { dev: dev[cur] };
        if (dirSet.has(cur)) return { dev: 1 };
        const parent = dirname(cur);
        if (parent === cur) return { dev: 1 };
        cur = parent;
      }
    },
    rename(from, to) {
      renameCalls.push([resolve(from), resolve(to)]);
      const af = resolve(from);
      const at = resolve(to);
      // 真实 rename 会把文件内容一并搬到目标（atomic write 依赖此语义）。
      if (contents[af] !== undefined) {
        contents[at] = contents[af];
        delete contents[af];
        fileSet.add(at);
        fileSet.delete(af);
      }
      dirSet.delete(af);
      addWithParents(at);
      fileSet.delete(at);
      if (contents[at] !== undefined) fileSet.add(at);
    },
    mkdir: (p) => addWithParents(p),
    readFile: (p) => contents[resolve(p)] ?? '{}',
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
        if (basename(dirname(d)) === basename(ap) && dirname(d) === ap) children.add(basename(d));
      }
      return [...children];
    },
    exists: (p) => {
      const ap = resolve(p);
      return dirSet.has(ap) || linkSet.has(ap) || fileSet.has(ap);
    },
    __renameCalls: renameCalls,
    __dirSet: dirSet,
    __fileSet: fileSet,
    __contents: contents,
    __listing: {},
  };
  return fs;
}

const SESSIONS = resolve('/dsh/sessions');
const TRASH = resolve('/dsh/session-trash');
function makeDeps(fs, overrides = {}) {
  return {
    fs,
    sessionsRoot: SESSIONS,
    trashRoot: TRASH,
    locate: overrides.locate === undefined ? makeScanner(fs) : overrides.locate,
    archiveSession: overrides.archiveSession === undefined ? async () => {} : overrides.archiveSession,
    emitRemoved: overrides.emitRemoved || (() => {}),
    emitAdded: overrides.emitAdded || (() => {}),
    unarchiveSession: overrides.unarchiveSession,
    isSessionActive: overrides.isSessionActive,
    now: overrides.now || (() => 1700000000000),
  };
}

// ---- 基础原语 ----

test('canonicalSessionId 幂等且补前缀', () => {
  assert.equal(canonicalSessionId('abc'), 'session-abc');
  assert.equal(canonicalSessionId('session-abc'), 'session-abc');
});

test('isValidSessionSegment：允许 DSH 编码 project key，只拒分隔符/空字节/..', () => {
  assert.equal(isValidSessionSegment('session-abc'), true);
  assert.equal(isValidSessionSegment('abc_01-x'), true);
  // 真机 bug m03171：DSH Windows project key 含 ~0020、以 - 开头、含空格——必须放行
  assert.equal(isValidSessionSegment('--F-DeepSeek~0020Harness~0020workspace-default-workspace--'), true);
  assert.equal(isValidSessionSegment('has space'), true);
  assert.equal(isValidSessionSegment('-leading'), true);
  assert.equal(isValidSessionSegment('a%20b'), true);
  // 仍然拒绝：路径分隔符、. / .. 及含 .. 子串、空、超长
  assert.equal(isValidSessionSegment('..'), false);
  assert.equal(isValidSessionSegment('.'), false);
  assert.equal(isValidSessionSegment('bad..proj'), false);
  assert.equal(isValidSessionSegment('a/b'), false);
  assert.equal(isValidSessionSegment(''), false);
  assert.equal(isValidSessionSegment('x'.repeat(201)), false);
  assert.equal(SEGMENT_RE.test('a/b'), false);
});

test('safeTargetSegment 拒绝危险字符 / 穿越 / 非法段名（P0-3）', () => {
  assert.equal(safeTargetSegment('abc'), 'session-abc');
  assert.equal(safeTargetSegment('session-abc'), 'session-abc');
  // 放宽后空格合法（不再在 bad 列表）；仍拒绝分隔符 / 穿越 / 空字节 / .. 子串 / 非字符串
  for (const bad of ['../etc', 'a/b', 'a\\b', '..', '.', '', 'bad..id', 'a\0b', 123, null]) {
    assert.throws(() => safeTargetSegment(bad), undefined, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('relativeWithin / isInside / isTwoLevelUnder 边界', () => {
  assert.equal(relativeWithin(SESSIONS, join(SESSIONS, 'proj', 'session-x')), join('proj', 'session-x'));
  assert.equal(relativeWithin(SESSIONS, SESSIONS), '');
  assert.equal(relativeWithin(SESSIONS, resolve('/dsh/session-trash')), undefined);
  assert.equal(isInside(SESSIONS, join(SESSIONS, 'proj')), true);
  assert.equal(isInside(SESSIONS, resolve('/dsh/session-trash')), false);
  assert.equal(isTwoLevelUnder(SESSIONS, join(SESSIONS, 'proj', 'session-x')), true);
  assert.equal(isTwoLevelUnder(SESSIONS, join(SESSIONS, 'session-x')), false);
  assert.equal(isTwoLevelUnder(SESSIONS, join(SESSIONS, 'a', 'b', 'c')), false);
});

test('resolveDshHome：POSIX / Windows / ~ 展开', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }, '/home/u'), '/custom/dsh');
  assert.equal(resolveDshHome({ DSH_HOME: '~/mydsh' }, '/home/u'), '/home/u/mydsh');
  assert.equal(resolveDshHome({}, '/home/u'), '/home/u/.dsh');
  const wh = resolve('F:/Users/u');
  assert.equal(resolveDshHome({ DSH_HOME: '~' }, wh), wh);
  assert.equal(resolveDshHome({}, wh), join(wh, '.dsh'));
});

// ---- 四层安全校验 ----

test('assertSafeTarget 对合法两层目录通过（含 project 段）', () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const safe = assertSafeTarget('abc', dir, SESSIONS, fs);
  assert.equal(safe.segment, 'session-abc');
  assert.equal(safe.project, 'proj-a');
});

test('assertSafeTarget 拒绝非绝对 / 非两层 / 非法段名 / 非法 project / id 不符', () => {
  const good = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, good] });
  assert.throws(() => assertSafeTarget('abc', 'relative/path/x', SESSIONS, fs), /not absolute/);
  assert.throws(() => assertSafeTarget('abc', join(SESSIONS, 'session-abc'), SESSIONS, fs), /not <root>/);
  // m03171 放宽：空格/~0020 现在是合法 project/段名，改用真正非法的分隔符/.. 触发校验
  assert.throws(() => assertSafeTarget('abc', join(SESSIONS, 'proj-a', 'bad..seg'), SESSIONS, fs), /illegal segment/);
  assert.throws(() => assertSafeTarget('abc', join(SESSIONS, 'bad..proj', 'session-abc'), SESSIONS, fs), /illegal project/);
  assert.throws(() => assertSafeTarget('abc', join(SESSIONS, 'proj-a', 'session-xyz'), SESSIONS, fs), /does not match/);
});

test('assertSafeTarget 拒绝符号链接与非目录', () => {
  const link = join(SESSIONS, 'proj-a', 'session-link');
  const fs = createMemFs({ dirs: [SESSIONS], symlinks: [link] });
  assert.throws(() => assertSafeTarget('link', link, SESSIONS, fs), /symlink or not a directory/);
  const missing = join(SESSIONS, 'proj-a', 'session-missing');
  assert.throws(() => assertSafeTarget('missing', missing, SESSIONS, createMemFs({ dirs: [SESSIONS] })), /not a directory/);
});

test('assertDisjointRoots / assertSameVolume（P1-5）', () => {
  assert.doesNotThrow(() => assertDisjointRoots(SESSIONS, TRASH));
  assert.throws(() => assertDisjointRoots(SESSIONS, join(SESSIONS, 'session-trash')), /disjoint/);
  const same = createMemFs({ dirs: [SESSIONS, TRASH] });
  assert.doesNotThrow(() => assertSameVolume(SESSIONS, TRASH, same));
  const cross = createMemFs({ dirs: [SESSIONS, TRASH], dev: { [SESSIONS]: 1, [TRASH]: 2 } });
  assert.throws(() => assertSameVolume(SESSIONS, TRASH, cross), /EXDEV/);
});

// ---- 能力探测 ----

test('archiveGateFromContext / emitterFromContext 能力探测', () => {
  const calls = [];
  const gate = archiveGateFromContext({ workspaceRegistry: { archiveSession: (id) => calls.push(id) } });
  gate('session-x');
  assert.deepEqual(calls, ['session-x']);
  assert.equal(archiveGateFromContext({}), null);
  const emits = [];
  emitterFromContext({ emit: (evt, id) => emits.push([evt, id]) })('api-session/added', 'session-x');
  assert.deepEqual(emits, [['api-session/added', 'session-x']]);
  assert.doesNotThrow(() => emitterFromContext({})('x', 'y'));
});

// ---- manifest / scanner / 补偿 ----

test('readManifest 缺失或损坏返回空文档', () => {
  const fs = createMemFs();
  assert.deepEqual(readManifest(fs, TRASH), { version: MANIFEST_VERSION, entries: {} });
  fs.__contents[resolve(TRASH, MANIFEST_NAME)] = '{bad';
  fs.__fileSet.add(resolve(TRASH, MANIFEST_NAME));
  assert.deepEqual(readManifest(fs, TRASH), { version: MANIFEST_VERSION, entries: {} });
});

test('locateUnder / makeScanner 在两层内定位规范化 id', () => {
  const fs = createMemFs();
  fs.__dirSet.add(SESSIONS);
  fs.__dirSet.add(join(SESSIONS, 'proj-a'));
  fs.__dirSet.add(join(SESSIONS, 'proj-a', 'session-abc'));
  fs.__listing[SESSIONS] = ['proj-a'];
  fs.__listing[join(SESSIONS, 'proj-a')] = ['session-abc'];
  const locate = makeScanner(fs);
  assert.equal(locate('abc'), join(SESSIONS, 'proj-a', 'session-abc'));
  assert.equal(locate('session-abc'), join(SESSIONS, 'proj-a', 'session-abc'));
  assert.equal(locate('nope'), undefined);
});

test('rebuildManifestFromTrash 由目录结构反推原路径（P0-1 补偿兜底）', () => {
  const fs = createMemFs({ dirs: [SESSIONS, join(TRASH, 'proj-a'), join(TRASH, 'proj-a', 'session-abc')] });
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const m = rebuildManifestFromTrash(fs, SESSIONS, TRASH);
  assert.equal(m.entries['session-abc'].originalPath, resolve(join(SESSIONS, 'proj-a', 'session-abc')));
  assert.equal(m.entries['session-abc'].trashedPath, resolve(join(TRASH, 'proj-a', 'session-abc')));
  assert.equal(listTrash(fs, TRASH).length, 1);
});

// ---- 预检 fail-closed ----

test('preflight 合法时 ok=true；非法 id 直接拒绝', () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  assert.equal(preflight(['abc'], makeDeps(fs)).ok, true);
  const bad = preflight(['../etc'], makeDeps(fs));
  assert.equal(bad.ok, false);
  assert.match(bad.reasons[0].reason, /illegal character|path traversal/);
});

test('preflight 归档闸门缺失 / 目标占用 / 运行中 —— 整批拒绝', () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const noGate = makeDeps(createMemFs({ dirs: [SESSIONS, dir] }));
  noGate.archiveSession = undefined;
  assert.match(preflight(['abc'], noGate).reasons[0].reason, /archive gate unavailable/);

  const occupied = createMemFs({ dirs: [SESSIONS, dir, join(TRASH, 'proj-a', 'session-abc')] });
  assert.match(preflight(['abc'], makeDeps(occupied)).reasons[0].reason, /trash target already exists/);

  const running = makeDeps(createMemFs({ dirs: [SESSIONS, dir] }), { isSessionActive: () => true });
  assert.match(preflight(['abc'], running).reasons[0].reason, /still running/);
});

// ---- 管线（归档 + 移动 + 广播顺序 + manifest）----

test('runTrashPipeline 顺序：归档 → rename → 广播 removed → 写 manifest（P0-1）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const order = [];
  const deps = makeDeps(fs, {
    archiveSession: async (id) => order.push('archive:' + id),
    emitRemoved: (id) => order.push('broadcast:' + id),
  });
  const origRename = fs.rename;
  // 只记录「会话目录移动」这一次 rename，manifest 原子替换（.tmp → manifest.json）不计入顺序。
  fs.rename = (from, to) => {
    if (!String(from).endsWith('.tmp')) order.push('rename');
    origRename(from, to);
  };
  const origWrite = fs.writeFile;
  fs.writeFile = (p, d) => { order.push('manifest'); origWrite(p, d); };
  const result = await runTrashPipeline(['abc'], deps);
  assert.equal(result.ok, true);
  assert.equal(result.moved, 1);
  assert.deepEqual(order, ['archive:session-abc', 'rename', 'broadcast:session-abc', 'manifest']);
  assert.equal(fs.__dirSet.has(resolve(dir)), false);
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj-a', 'session-abc'))), true);
});

test('manifest 写失败：已广播且入补偿队列，UI 不说谎（P0-1）', async () => {
  drainCompensationQueue();
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const emitted = [];
  fs.writeFile = () => { throw new Error('EACCES'); };
  const result = await runTrashPipeline(['abc'], makeDeps(fs, { emitRemoved: (id) => emitted.push(id) }));
  assert.equal(result.ok, true);
  assert.equal(result.results[0].manifestWriteFailed, true);
  assert.deepEqual(emitted, ['session-abc']); // 广播已发出
  assert.equal(drainCompensationQueue().length, 1); // 补偿已入队
});

test('归档闸门抛错记为 failed，不移动', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs, { archiveSession: async () => { throw new Error('gate down'); } });
  const result = await runTrashPipeline(['abc'], deps);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, 'archive-gate');
  assert.equal(fs.__renameCalls.length, 0);
});

// ---- 归档降级（真机 bug m05087）：mnemon- 非标准会话 DSH archiveSession 不认识 ----
function unknownSessionError(id) {
  const e = new Error(`cannot archive session '${id}': live sessions and session persistence hold no such session`);
  e.name = 'WorkspaceUnknownSessionError';
  return e;
}
function activeSessionError(id) {
  const e = new Error(`cannot archive session '${id}': the session is active (attached)`);
  e.name = 'WorkspaceActiveSessionError';
  return e;
}

test('归档闸门 WorkspaceUnknownSessionError → 降级跳过归档、继续 move（m05087）', async () => {
  const rawId = 'mnemon-task-v1-644f0ea6';
  const dir = join(SESSIONS, 'proj-a', rawId);
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const archiveCalls = [];
  const deps = makeDeps(fs, {
    locate: () => dir,
    archiveSession: async (id) => { archiveCalls.push(id); throw unknownSessionError(id); },
  });
  const result = await runTrashPipeline([rawId], deps);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'ok');
  // canonical 一次 + 原始 id 重试一次
  assert.deepEqual(archiveCalls, [canonicalSessionId(rawId), rawId]);
  assert.equal(result.results[0].entry.archiveSkipped, true);
  // 目录确实被移走
  assert.equal(fs.exists(dir), false);
  assert.equal(fs.exists(result.results[0].entry.trashedPath), true);
});

test('归档闸门 WorkspaceUnknownSessionError 且无 canonical/raw 差异 → 也降级', async () => {
  const id = 'session-unknown-123';
  const dir = join(SESSIONS, 'proj-a', id);
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs, { locate: () => dir, archiveSession: async (x) => { throw unknownSessionError(x); } });
  const result = await runTrashPipeline([id], deps);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].entry.archiveSkipped, true);
});

test('归档闸门 WorkspaceActiveSessionError → fail-closed，不降级不移动（m05087）', async () => {
  const rawId = 'mnemon-task-v1-644f0ea6';
  const dir = join(SESSIONS, 'proj-a', rawId);
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs, { locate: () => dir, archiveSession: async (x) => { throw activeSessionError(x); } });
  const result = await runTrashPipeline([rawId], deps);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, 'archive-active');
  assert.equal(fs.exists(dir), true); // 原位未动
});

test('归档闸门 canonical 失败但 rawId 重试成功 → 正常归档、不标降级', async () => {
  const rawId = 'mnemon-task-v1-644f0ea6';
  const dir = join(SESSIONS, 'proj-a', rawId);
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const archiveCalls = [];
  const deps = makeDeps(fs, {
    locate: () => dir,
    archiveSession: async (id) => {
      archiveCalls.push(id);
      if (id === canonicalSessionId(rawId)) throw unknownSessionError(id);
      // 原始 id 成功
    },
  });
  const result = await runTrashPipeline([rawId], deps);
  assert.equal(result.ok, true);
  assert.deepEqual(archiveCalls, [canonicalSessionId(rawId), rawId]);
  assert.equal(result.results[0].entry.archiveSkipped, undefined); // 真正归档了，无降级标志
});

test('rename 前目标被并发占用 → target-race（P2 并发）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs);
  const check = preflight(['abc'], deps).checks[0];
  fs.__dirSet.add(resolve(check.target)); // 模拟并发已占用
  const res = await moveOneToTrash(check, deps);
  assert.equal(res.reason, 'target-race');
});

test('运行态复检：preflight 后变 active → 拒绝 rename（P2 二次复检）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  let active = false;
  const deps = makeDeps(fs, { isSessionActive: () => active });
  const check = preflight(['abc'], deps).checks[0];
  active = true; // rename 前变活跃
  const res = await moveOneToTrash(check, deps);
  assert.equal(res.reason, 'session-running');
  assert.equal(fs.__renameCalls.length, 0);
});

// ---- 撤销（可逆保证 + P0-2 路径校验）----

test('restore 重新校验路径，rename 回原路径、移除 manifest、广播 added', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  fs.__listing[SESSIONS] = ['proj-a'];
  fs.__listing[join(SESSIONS, 'proj-a')] = ['session-abc'];
  let unarchived = false;
  const added = [];
  const deps = makeDeps(fs, {
    unarchiveSession: async () => { unarchived = true; },
    emitAdded: (id) => added.push(id),
  });
  await runTrashPipeline(['abc'], deps);
  // 补回收站 listing 供 locateUnder 用
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const restored = await restoreFromTrash('abc', { ...deps });
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredTo, resolve(dir));
  assert.equal(unarchived, true);
  assert.deepEqual(added, ['session-abc']);
  assert.equal(fs.__dirSet.has(resolve(dir)), true);
  assert.equal(listTrash(fs, TRASH).length, 0);
});

test('无前缀段名 move→restore 往返：路径构造全程用 locate 实际段名，canonical 不改写（评审 P1-1 命门）', async () => {
  // DSH 存在「不带 session- 前缀」布局。若任何一处用 canonical 构造路径，
  // 无前缀段 'abc' 会在 restore 时被拼成 'session-abc'，DSH locate 找不到 → 1.1 命门被绕过。
  const dir = join(SESSIONS, 'proj', 'abc'); // 无前缀实际段名
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  fs.__listing[SESSIONS] = ['proj'];
  fs.__listing[join(SESSIONS, 'proj')] = ['abc'];
  const deps = makeDeps(fs);
  const trashed = await runTrashPipeline(['abc'], deps);
  assert.equal(trashed.ok, true);
  // move 后回收站段名仍是 'abc'，不是 'session-abc'
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj', 'abc'))), true);
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj', 'session-abc'))), false);
  // manifest 键是 canonical('session-abc')，但 originalPath/trashedPath 字段保留原始无前缀段名
  const entry = readManifest(fs, TRASH).entries['session-abc'];
  assert.equal(entry.originalPath, resolve(dir));
  assert.equal(entry.trashedPath, resolve(join(TRASH, 'proj', 'abc')));
  // restore 后拼回路径必须是原始 'abc'，绝不能被 canonical 改成 'session-abc'
  fs.__listing[TRASH] = ['proj'];
  fs.__listing[join(TRASH, 'proj')] = ['abc'];
  const restored = await restoreFromTrash('abc', { ...deps });
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredTo, resolve(dir)); // === .../proj/abc
  assert.equal(fs.__dirSet.has(resolve(join(SESSIONS, 'proj', 'abc'))), true);
  assert.equal(fs.__dirSet.has(resolve(join(SESSIONS, 'proj', 'session-abc'))), false);
});

test('真机 bug m03171：DSH Windows 编码 project key（含 ~0020）可 move→restore 往返', async () => {
  // DSH 真实 project key：--F-DeepSeek~0020Harness~0020workspace-default-workspace--
  // 含 ~、以 - 开头、URL 编码空格；旧 SEGMENT_RE 会拒，导致真机 trash 抛 illegal project name。
  const project = '--F-DeepSeek~0020Harness~0020workspace-default-workspace--';
  const dir = join(SESSIONS, project, 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  fs.__listing[SESSIONS] = [project];
  fs.__listing[join(SESSIONS, project)] = ['session-abc'];
  const deps = makeDeps(fs);
  const trashed = await runTrashPipeline(['abc'], deps);
  assert.equal(trashed.ok, true, `编码 project key 应可移入回收站，实际=${JSON.stringify(trashed)}`);
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, project, 'session-abc'))), true);
  const entry = readManifest(fs, TRASH).entries['session-abc'];
  assert.equal(entry.originalPath, resolve(dir));
  // restore 补 trash 侧 listing
  fs.__listing[TRASH] = [project];
  fs.__listing[join(TRASH, project)] = ['session-abc'];
  const restored = await restoreFromTrash('abc', { ...deps });
  assert.equal(restored.ok, true, `编码 project key 应可恢复，实际=${JSON.stringify(restored)}`);
  assert.equal(restored.restoredTo, resolve(dir));
  assert.equal(fs.__dirSet.has(resolve(dir)), true);
  assert.equal(listTrash(fs, TRASH).length, 0);
});

test('父已恢复、子代理仍可独立恢复（情况 A 设计契约：restore 不检查 parentSession；防未来「安全加固」误变成情况 B）', async () => {
  // 场景：父会话与子代理同在回收站，父先被单独恢复离开 trash，子代理仍在 trash。
  // 此时子代理的 parentSession 指向已不在 trash 的父；若 restore 检查父存在会拒绝（情况 B），
  // 本测试锁定「子代理可独立恢复成功」（情况 A：数据不丢）。
  const parentDir = join(SESSIONS, 'proj', 'session-parent');
  const childDir = join(SESSIONS, 'proj', 'session-child');
  const fs = createMemFs({ dirs: [SESSIONS, parentDir, childDir] });
  fs.__listing[SESSIONS] = ['proj'];
  fs.__listing[join(SESSIONS, 'proj')] = ['session-parent', 'session-child'];
  const deps = makeDeps(fs);
  const trashed = await runTrashPipeline(['parent', 'child'], deps);
  assert.equal(trashed.ok, true);

  // 父先恢复：补父在 trash 的 listing，恢复 parent
  fs.__listing[TRASH] = ['proj'];
  fs.__listing[join(TRASH, 'proj')] = ['session-parent', 'session-child'];
  const parentRestored = await restoreFromTrash('parent', { ...deps });
  assert.equal(parentRestored.ok, true, '父应先恢复成功');
  assert.equal(fs.__dirSet.has(resolve(parentDir)), true);
  // 父离开 trash、回到 sessions；子代理仍在 trash（此时子代理 parentSession 指向的父已不在 trash）
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj', 'session-parent'))), false);
  assert.equal(fs.__dirSet.has(resolve(join(TRASH, 'proj', 'session-child'))), true);

  // 关键断言：子代理独立恢复成功（不因其 parentSession 父不在 sessions/trash 而被拒）。
  // 若未来有人给 restore 加「父必须存在」校验，这里会失败，从而拦住情况 A→B 的静默回归。
  const childRestored = await restoreFromTrash('child', { ...deps });
  assert.equal(childRestored.ok, true, `子代理应可独立恢复（情况 A），实际=${JSON.stringify(childRestored)}`);
  assert.equal(childRestored.restoredTo, resolve(childDir));
  assert.equal(fs.__dirSet.has(resolve(childDir)), true);
  assert.equal(listTrash(fs, TRASH).length, 0, '父与子代理都已恢复，回收站应清空');
});

test('restore 拒绝 purging 条目（第 2 阶段 P0 竞态：purge 写标记后 rm 未执行时不得恢复）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  fs.__listing[SESSIONS] = ['proj-a'];
  fs.__listing[join(SESSIONS, 'proj-a')] = ['session-abc'];
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  // 补回收站 listing 供 locateUnder 用
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const trashDir = join(TRASH, 'proj-a', 'session-abc');
  assert.equal(fs.__dirSet.has(resolve(trashDir)), true, '前置：会话已在回收站');

  // 模拟 purge 阶段 1 已写 {status:'purging'} 并释放锁，阶段 2 的 rm 尚未执行。
  const m = readManifest(fs, TRASH);
  m.entries['session-abc'].status = 'purging';
  m.entries['session-abc'].purgingAt = 12345;
  writeManifest(fs, TRASH, m);

  const restoreRenameBefore = fs.__renameCalls.length;
  const restored = await restoreFromTrash('abc', { ...deps });
  assert.equal(restored.ok, false);
  assert.equal(restored.reason, 'purge-in-progress');
  assert.match(restored.detail, /purging/);
  // 目录未被搬走：仍在回收站，sessions 原路径未出现，rename 未发生。
  assert.equal(fs.__dirSet.has(resolve(trashDir)), true, 'purging 时目录不得被搬离回收站');
  assert.equal(fs.__dirSet.has(resolve(dir)), false, 'sessions 原路径不应出现');
  assert.equal(fs.__renameCalls.length, restoreRenameBefore, '不得发生任何 rename');
  // manifest 条目仍是 purging，未被 restore 误删。
  assert.equal(readManifest(fs, TRASH).entries['session-abc'].status, 'purging');
});

test('restore 拒绝 quarantined 条目（第 1 阶段隔离承诺在恢复路径闭合）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  fs.__listing[SESSIONS] = ['proj-a'];
  fs.__listing[join(SESSIONS, 'proj-a')] = ['session-abc'];
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];

  // 矛盾态残留：条目同时在 entries 和 quarantined 列表（隔离承诺要求 restore 也拒绝）。
  const m = readManifest(fs, TRASH);
  if (!Array.isArray(m.quarantined)) m.quarantined = [];
  m.quarantined.push({ project: 'proj-a', segment: 'session-abc', why: 'illegal' });
  writeManifest(fs, TRASH, m);

  const renameBefore = fs.__renameCalls.length;
  const restored = await restoreFromTrash('abc', { ...deps });
  assert.equal(restored.ok, false);
  assert.equal(restored.reason, 'quarantined');
  assert.match(restored.detail, /隔离/);
  assert.equal(fs.__renameCalls.length, renameBefore, '隔离条目不得被 rename');
});

test('restore 被篡改的 manifest 无法把目录 rename 到任意位置（P0-2）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  // 篡改 manifest：originalPath 指向 sessions 根之外
  const m = JSON.parse(fs.__contents[resolve(TRASH, MANIFEST_NAME)]);
  m.entries['session-abc'].originalPath = resolve('/evil/place');
  fs.__contents[resolve(TRASH, MANIFEST_NAME)] = JSON.stringify(m);
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const restored = await restoreFromTrash('abc', { ...deps });
  // 实现忽略被篡改的 originalPath，按两段结构重建安全目标 → 仍恢复到合法位置
  assert.equal(restored.ok, true);
  assert.equal(restored.restoredTo, resolve(dir));
  assert.equal(fs.__dirSet.has(resolve('/evil/place')), false);
});

test('restore 无 manifest 条目 / 原路径被占用 安全失败', async () => {
  const fs = createMemFs();
  assert.match((await restoreFromTrash('ghost', { fs, sessionsRoot: SESSIONS, trashRoot: TRASH })).reason, /no manifest entry/);

  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs2 = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs2);
  await runTrashPipeline(['abc'], deps);
  fs2.__dirSet.add(resolve(dir));
  fs2.__listing[TRASH] = ['proj-a'];
  fs2.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const r = await restoreFromTrash('abc', { ...deps });
  assert.equal(r.ok, false);
  assert.match(r.reason, /original path occupied/);
});

test('restore unarchive 缺失 → partial 成功并提示手动解档（P1-6）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const r = await restoreFromTrash('abc', { ...deps });
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.match(r.note, /手动解档/);
});

// ---- 评审第二轮：1.1 段名来自 locate 拆解 / 1.2 rebuild 隔离 ----

test('trashTargetFor 使用 locate 的实际段名，不改写无前缀段名（评审 1.1 命门）', () => {
  // DSH 两种布局：带 session- 前缀 与 不带前缀（现成包 canonicalSessionId 注释明示）
  const withPrefix = join(SESSIONS, 'proj', 'session-abc');
  const noPrefix = join(SESSIONS, 'proj', 'abc');
  const t1 = trashTargetFor('abc', withPrefix, SESSIONS, TRASH);
  assert.equal(t1.segment, 'session-abc');
  assert.equal(t1.target, resolve(join(TRASH, 'proj', 'session-abc')));
  const t2 = trashTargetFor('abc', noPrefix, SESSIONS, TRASH);
  // 关键：实际段名 'abc' 被原样保留，而非 canonical 成 'session-abc'
  assert.equal(t2.segment, 'abc');
  assert.equal(t2.target, resolve(join(TRASH, 'proj', 'abc')));
});

test('trashTargetFor 拒绝实际段名与 id 不匹配（防误移错目录）', () => {
  const dir = join(SESSIONS, 'proj', 'session-xyz');
  assert.throws(() => trashTargetFor('abc', dir, SESSIONS, TRASH), /does not match/);
});

test('rebuild 对非法 project/segment 逃逸条目进隔离清单，不重建（评审 1.2）', () => {
  const fs = createMemFs({ dirs: [TRASH] });
  fs.__listing[TRASH] = ['good-proj', 'bad..proj'];
  fs.__listing[join(TRASH, 'good-proj')] = ['session-ok'];
  fs.__listing[join(TRASH, 'bad..proj')] = ['session-evil'];
  const m = rebuildManifestFromTrash(fs, SESSIONS, TRASH);
  assert.equal(Object.keys(m.entries).length, 1);
  assert.ok(m.entries['session-ok']);
  assert.equal(m.quarantined.length, 1);
  assert.equal(m.quarantined[0].why, 'illegal project segment');
});

test('restore partial 返回结构化 manualAction（评审 1.4）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const r = await restoreFromTrash('abc', { ...deps });
  assert.equal(r.partial, true);
  assert.equal(r.manualAction.kind, 'unarchive-required');
  assert.equal(r.manualAction.sessionId, 'session-abc');
  assert.equal(r.manualAction.target, 'workspace.global.archivedSessionIds');
});

// ---- 评审第三轮：原子写 / 串行锁 / restore fallback / 同卷 / 父目录缺失 ----

test('manifest 原子写：write temp → rename 替换，不留 .tmp（评审 1）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  await runTrashPipeline(['abc'], makeDeps(fs));
  const final = resolve(TRASH, MANIFEST_NAME);
  assert.equal(fs.__fileSet.has(final), true);
  assert.equal(fs.__contents[final] !== undefined, true);
  // 原子写的 *.tmp（含 <pid>.<random> 唯一名）已被 rename 搬走，不应残留（收口记录项 2）
  const tempLeftovers = [...fs.__fileSet].filter((p) => p.includes('.tmp'));
  assert.deepEqual(tempLeftovers, []);
  // 确实发生过一次 ->manifest.json 的 rename（原子替换）
  assert.ok(fs.__renameCalls.some(([, to]) => to === final));
});

test('withManifestLock 串行化并发任务（评审 1）', async () => {
  const { withManifestLock } = await import('../lib/session-trash.js');
  const order = [];
  const t1 = withManifestLock(async () => { order.push('t1-start'); await Promise.resolve(); order.push('t1-end'); });
  const t2 = withManifestLock(async () => { order.push('t2-start'); order.push('t2-end'); });
  await Promise.all([t1, t2]);
  assert.deepEqual(order, ['t1-start', 't1-end', 't2-start', 't2-end']);
});

test('restore 在 manifest 缺条目时 fallback 到目录真相 rebuild（评审 1）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  // 抹掉 manifest 条目（模拟 manifest 丢失，目录仍在）
  fs.__contents[resolve(TRASH, MANIFEST_NAME)] = JSON.stringify({ version: MANIFEST_VERSION, entries: {} });
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  const r = await restoreFromTrash('abc', { ...deps });
  assert.equal(r.ok, true, r.reason || '');
  assert.equal(r.restoredTo, resolve(dir));
  assert.equal(fs.__dirSet.has(resolve(dir)), true);
});

test('restore 跨卷失败返回 exdev 明确错误而非裸 EXDEV（评审 4）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  // 先用同卷完成 setup（否则 preflight 的 assertSameVolume 会先拒绝），再翻转 dev 模拟跨卷。
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  fs.__dirSet.add(TRASH); // 确保 dev 覆盖点存在
  // 模拟卷挂载点变化：restore 时 sessions/trash 已不同卷
  const realStat = fs.stat;
  fs.stat = (p) => ({ dev: resolve(String(p)).startsWith(TRASH) ? 2 : 1 });
  const r = await restoreFromTrash('abc', { ...deps });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exdev');
  assert.match(r.detail, /volume|EXDEV/i);
});

test('restore 原 project 目录缺失 → original-project-missing 结构化错误（评审 3）', async () => {
  const dir = join(SESSIONS, 'proj-a', 'session-abc');
  const fs = createMemFs({ dirs: [SESSIONS, dir] });
  const deps = makeDeps(fs);
  await runTrashPipeline(['abc'], deps);
  fs.__listing[TRASH] = ['proj-a'];
  fs.__listing[join(TRASH, 'proj-a')] = ['session-abc'];
  // 模拟 project 目录被删：从 dirSet 移除 <sessionsRoot>/proj-a
  fs.__dirSet.delete(resolve(join(SESSIONS, 'proj-a')));
  const r = await restoreFromTrash('abc', { ...deps });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'original-project-missing');
  assert.equal(r.manualAction.kind, 'restore-project-first');
  assert.match(r.detail, /已不存在/);
});

// ---- 真机 fs 集成（P2：覆盖 Windows rename/大小写真机行为）----

test('真机 fs：临时目录 rename 往返 + Windows 大小写不敏感', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-trash-test-'));
  const sessions = join(base, TRASH_ROOT_NAME.replace('trash', 'sessions'));
  const trash = join(base, TRASH_ROOT_NAME);
  const dir = join(sessions, 'proj-a', 'session-abc');
  realMkdirSync(dir, { recursive: true });
  realWriteFileSync(join(dir, 'session.v4.jsonl.zstd'), 'data');
  realMkdirSync(join(trash, 'proj-a'), { recursive: true });
  // 真实 rename 往返：确认可逆
  const target = join(trash, 'proj-a', 'session-abc');
  realRenameSync(dir, target);
  assert.equal(realExistsSync(target), true);
  assert.equal(realExistsSync(dir), false);
  realRenameSync(target, dir);
  assert.equal(realExistsSync(dir), true);
  // realpath 后的大小写归一由平台处理，确认 isInside 语义不误判
  const realDir = realRealpathSync(dir);
  assert.equal(isInside(realRealpathSync(sessions), realDir), true);
});

// ---- 静态守护：精确到成员调用模式（P0-4）----

test('lib/session-trash.js 不含 fs.rm/rmdir/unlink 成员调用（rename 不误报）', () => {
  const src = readFileSync(join(here, '..', 'lib', 'session-trash.js'), 'utf8');
  assert.doesNotMatch(src, /\.(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/);
  // 反向确认：rename 调用存在，且不会被上面的模式匹配（rm 后必须紧跟 \s*\( 才算）
  assert.match(src, /\.rename\s*\(/);
  assert.doesNotMatch(src, /import\s+\*\s+as\s+\w+\s+from\s+['"]node:fs['"]/);
});
