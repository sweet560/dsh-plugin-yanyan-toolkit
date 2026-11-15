// dsh-plugin-yanyan-subagent / test/log-rewrite.test.mjs
//
// lib/log-rewrite.js 与 lib/zstd-frames.js 的纯文件操作单测。
// 全部用 os.tmpdir 造临时 DSH_HOME，绝不触碰真实运行时目录。
//
// 真实 API 事实（读 lib/log-rewrite.js / lib/zstd-frames.js 后确认）：
//   · encodeLog / decodeLog / scanZstdFrames 由 lib/zstd-frames.js 导出；
//     lib/log-rewrite.js 只内部 import，未 re-export。
//   · rewriteCatalogRowsInFile 成功返回 { ok:true, removed, kept }（kept 是事件行数）。
//   · rewriteCatalogRows 无日志返回 { ok:false, removed:0, reason:'no-log' }。
//   · flushPendingRewrites 返回 { ok:true, parents, cleared, removed }；
//     无 pending 时返回 { ok:true, parents:0, removed:0 }（无 cleared 字段）。
//   · flush / scrub 的 gone 谓词均为：
//       (id) => !stored.has(id) && !stored.has('session-' + id)
//     其中 stored = storedSessionDirNames(dshHome)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { encodeLog, decodeLog, scanZstdFrames } from '../lib/zstd-frames.js';
import {
  logCoreId, logVariants, findSessionDirs, allSessionLogPaths,
  storedSessionDirNames, dropProjectionCache, readCatalogEvents,
  rewriteCatalogRowsInFile, rewriteCatalogRows, retireCatalogRowsEverywhere,
  retireCatalogRow, pendingFilePath, readPending, queueCatalogRetire,
  flushPendingRewrites, scrubCatalogRows,
} from '../lib/log-rewrite.js';

const NL = String.fromCharCode(10);

// ───────────────── 造日志 / 临时目录辅助 ─────────────────

function tmpHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'yanyan-logtest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 父目录名带 session- 前缀，位于 <dshHome>/sessions/<slug>/<parentId>/。 */
function sessionDir(dshHome, slug, parentId) {
  const dir = join(dshHome, 'sessions', slug, parentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function headerLine(id) {
  return JSON.stringify({ type: 'session', version: 4, id: 'session-' + id });
}

/** childId 是裸 id（无 session- 前缀）；mnemon 虚拟委派亦用裸 id 形式。 */
function catalogEvent(seq, childId, extra = {}) {
  return JSON.stringify({
    type: 'subagent/catalog', seq, time: 1000 + seq,
    data: {
      version: 3, childId, childCreatedAt: 500 + seq,
      mode: 'continuable', label: 'L' + seq, name: 'N' + seq, ...extra,
    },
  });
}

function retiredEvent(seq, childId) {
  return JSON.stringify({
    type: 'subagent-delete/retired', seq, time: 1000 + seq,
    ignorable: true, data: { childId, retiredAt: 1700000000000 },
  });
}

function writeLog(dir, hdr, eventLines) {
  const p = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(p, encodeLog(hdr, eventLines));
  return p;
}

function readLines(logPath) {
  return decodeLog(readFileSync(logPath)).split(NL).filter((l) => l.length > 0);
}

function projcacheDir(dshHome) {
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ───────────────── 必测场景 1 ─────────────────

test('场景1：logCoreId / logVariants 两种拼写归一化', () => {
  assert.equal(logCoreId('session-xxx'), 'xxx');
  assert.equal(logCoreId('xxx'), 'xxx');
  assert.equal(logCoreId('session-mnemon-run-v1-abc'), 'mnemon-run-v1-abc');
  assert.equal(logCoreId(''), '');
  assert.equal(logCoreId(null), '');
  assert.equal(logCoreId(undefined), '');
  assert.deepEqual(logVariants('session-xxx'), ['xxx', 'session-xxx']);
  assert.deepEqual(logVariants('xxx'), ['xxx', 'session-xxx']);
  assert.deepEqual(logVariants('session-mnemon-run-v1-abc'),
    ['mnemon-run-v1-abc', 'session-mnemon-run-v1-abc']);
});

// ───────────────── 必测场景 2 ─────────────────

test('场景2：rewriteCatalogRowsInFile 原位退休命中行、逐字保留未命中行', (t) => {
  const home = tmpHome(t);
  const dir = sessionDir(home, 'proj-a', 'session-parent-1');
  const hdr = headerLine('parent-1');
  const a = catalogEvent(0, 'a');
  const b = catalogEvent(1, 'b');
  const keep = catalogEvent(2, 'keep');
  const p = writeLog(dir, hdr, [a, b, keep]);
  assert.equal(readLines(p).length, 4, '初始 1 header + 3 事件');

  const r = rewriteCatalogRowsInFile(p, (id) => id === 'a' || id === 'b');
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  // 代码 line 229：return { ok: true, removed, kept: kept.length }
  assert.equal(r.kept, 3);

  const lines = readLines(p);
  assert.equal(lines.length, 4, '行数不变（原位替换，不删行）');
  assert.equal(lines[0], hdr, 'header 不变');
  for (const [idx, seq, childId] of [[1, 0, 'a'], [2, 1, 'b']]) {
    const e = JSON.parse(lines[idx]);
    assert.equal(e.type, 'subagent-delete/retired');
    assert.equal(e.seq, seq, 'seq 原样保留');
    assert.equal(e.time, 1000 + seq, 'time 原样保留');
    assert.equal(e.ignorable, true);
    assert.equal(e.data.childId, childId);
    assert.equal(typeof e.data.retiredAt, 'number', 'data.retiredAt 存在');
  }
  assert.equal(lines[3], keep, '未命中行逐字不变');
  assert.equal(JSON.parse(lines[3]).type, 'subagent/catalog');
});

// ───────────────── 必测场景 3 ─────────────────

test('场景3：rewriteCatalogRows 按 parentSessionId 定位日志；无日志返回 reason:no-log', (t) => {
  const home = tmpHome(t);
  const dir = sessionDir(home, 'proj-a', 'session-parent-1');
  const p = writeLog(dir, headerLine('parent-1'),
    [catalogEvent(0, 'a'), catalogEvent(1, 'b')]);

  // 带 session- 前缀的写法定位到父目录
  const r1 = rewriteCatalogRows(home, 'session-parent-1', (id) => id === 'a');
  assert.equal(r1.ok, true);
  assert.equal(r1.removed, 1);
  assert.equal(JSON.parse(readLines(p)[1]).type, 'subagent-delete/retired');

  // 裸 id 拼写（logVariants 归一化）同样能命中同一份日志
  const r2 = rewriteCatalogRows(home, 'parent-1', (id) => id === 'b');
  assert.equal(r2.ok, true);
  assert.equal(r2.removed, 1);
  assert.equal(JSON.parse(readLines(p)[2]).type, 'subagent-delete/retired');

  // 无日志：代码 line 242 真实 reason 为 'no-log'
  const empty = tmpHome(t);
  const r3 = rewriteCatalogRows(empty, 'nope', () => true);
  assert.deepEqual(r3, { ok: false, removed: 0, reason: 'no-log' });
});

// ───────────────── 必测场景 4 ─────────────────

test('场景4：readCatalogEvents 只返回仍会生成行的 subagent/catalog', (t) => {
  const home = tmpHome(t);
  const dir = sessionDir(home, 'proj-a', 'session-parent-1');
  const other = JSON.stringify({ type: 'message', seq: 2, time: 1002, data: { text: 'hi' } });
  writeLog(dir, headerLine('parent-1'), [
    catalogEvent(0, 'a'),
    retiredEvent(1, 'b'), // 已退休，不计入
    other,                 // 其它类型，不计入
  ]);

  const events = readCatalogEvents(home, 'session-parent-1');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    childId: 'a', label: 'L0', name: 'N0', mode: 'continuable',
    createdAt: 500, seq: 0, time: 1000,
  });
  for (const k of ['childId', 'label', 'name', 'mode', 'seq', 'time', 'createdAt']) {
    assert.ok(k in events[0], '字段含 ' + k);
  }
});

// ───────────────── 必测场景 5 ─────────────────

test('场景5：retireCatalogRowsEverywhere 多份日志全退休且父日志优先', (t) => {
  const home = tmpHome(t);
  // 故意把父日志放在按字母序靠后的 slug，验证 parentHint 排序把父提到最前。
  const parentDir = sessionDir(home, 'proj-z', 'session-parent-1');
  const histDir = sessionDir(home, 'proj-a', 'session-history-1');
  const parentLog = writeLog(parentDir, headerLine('parent-1'),
    [catalogEvent(0, 'mnemon-run-v1-ghost')]);
  const histLog = writeLog(histDir, headerLine('history-1'),
    [catalogEvent(0, 'mnemon-run-v1-ghost')]);
  const pc = projcacheDir(home);
  writeFileSync(join(pc, 'session-parent-1.json'), '{}');
  writeFileSync(join(pc, 'session-history-1.json'), '{}');

  const r = retireCatalogRowsEverywhere(home, ['mnemon-run-v1-ghost'], 'session-parent-1');
  assert.equal(r.removed, 2);
  assert.equal(r.scanned, 2);
  assert.deepEqual(r.failed, []);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].parentId, 'session-parent-1', '父日志优先被处理');
  assert.deepEqual(r.files.map((f) => f.parentId).sort(),
    ['session-history-1', 'session-parent-1']);
  assert.deepEqual(r.files.map((f) => f.removed), [1, 1]);
  assert.equal(JSON.parse(readLines(parentLog)[1]).type, 'subagent-delete/retired');
  assert.equal(JSON.parse(readLines(histLog)[1]).type, 'subagent-delete/retired');
  assert.equal(existsSync(join(pc, 'session-parent-1.json')), false, '父投影缓存被 dropProjectionCache 清除');
  assert.equal(existsSync(join(pc, 'session-history-1.json')), false, '历史投影缓存被清除');
});

// ───────────────── 必测场景 6 ─────────────────

test('场景6a：queueCatalogRetire + readPending + flushPendingRewrites 用 gone 谓词补做退休', (t) => {
  const home = tmpHome(t);
  const dir = sessionDir(home, 'proj-a', 'session-parent-1');
  const parentLog = writeLog(dir, headerLine('parent-1'), [
    catalogEvent(0, 'mnemon-run-v1-gone'),  // 子会话目录不存在 → gone=true
    catalogEvent(1, 'mnemon-run-v1-alive'), // 子会话目录仍在 → gone=false
  ]);
  // 仅给 alive 建目录（无日志也算「还在」，storedSessionDirNames 会收录目录名）
  mkdirSync(join(home, 'sessions', 'proj-a', 'mnemon-run-v1-alive'), { recursive: true });

  const pp = pendingFilePath(home);
  assert.equal(pp, join(home, 'yanyan-subagent-pending.json'));
  assert.deepEqual(readPending(pp), {}, 'pending 不存在时返回 {}');

  // 模拟一次失败后排队
  queueCatalogRetire(pp, 'session-parent-1', 'mnemon-run-v1-gone');
  assert.deepEqual(readPending(pp), { 'session-parent-1': ['mnemon-run-v1-gone'] });

  // live 为空 → 不跳过；flush 用 gone 谓词只退休目录已不在的行
  const r = flushPendingRewrites(home, new Set());
  assert.deepEqual(r, { ok: true, parents: 1, cleared: 1, removed: 1 });

  const lines = readLines(parentLog);
  assert.equal(JSON.parse(lines[1]).type, 'subagent-delete/retired', 'gone 行被补做退休');
  assert.equal(JSON.parse(lines[2]).type, 'subagent/catalog', 'alive 行保留');
  assert.deepEqual(readPending(pp), {}, '成功的父队列项被清除');

  // 代码 line 341：无 pending 时返回 { ok:true, parents:0, removed:0 }（无 cleared）
  const r2 = flushPendingRewrites(home, new Set());
  assert.deepEqual(r2, { ok: true, parents: 0, removed: 0 });
});

test('场景6b：flushPendingRewrites 跳过 liveAgentIds 里的父会话、不改写且保留队列', (t) => {
  const home = tmpHome(t);
  const dir = sessionDir(home, 'proj-a', 'session-parent-1');
  const parentLog = writeLog(dir, headerLine('parent-1'),
    [catalogEvent(0, 'mnemon-run-v1-gone')]);
  const pp = pendingFilePath(home);
  queueCatalogRetire(pp, 'session-parent-1', 'mnemon-run-v1-gone');

  // live 命中 parentId 本身 → continue，不 cleared、不 removed、不改写
  const r1 = flushPendingRewrites(home, new Set(['session-parent-1']));
  assert.deepEqual(r1, { ok: true, parents: 1, cleared: 0, removed: 0 });
  assert.equal(JSON.parse(readLines(parentLog)[1]).type, 'subagent/catalog');
  assert.deepEqual(readPending(pp), { 'session-parent-1': ['mnemon-run-v1-gone'] });

  // live 命中 coreId 变体（'parent-1'）同样跳过
  const r2 = flushPendingRewrites(home, new Set(['parent-1']));
  assert.deepEqual(r2, { ok: true, parents: 1, cleared: 0, removed: 0 });
  assert.equal(JSON.parse(readLines(parentLog)[1]).type, 'subagent/catalog');

  // 冷下来后补做退休成功
  const r3 = flushPendingRewrites(home, new Set());
  assert.deepEqual(r3, { ok: true, parents: 1, cleared: 1, removed: 1 });
  assert.equal(JSON.parse(readLines(parentLog)[1]).type, 'subagent-delete/retired');
});

// ───────────────── 必测场景 7 ─────────────────

test('场景7：scrubCatalogRows 退休目录已不存在的 catalog 行、保留目录仍在的行', (t) => {
  const home = tmpHome(t);
  const dir = sessionDir(home, 'proj-a', 'session-parent-1');
  const parentLog = writeLog(dir, headerLine('parent-1'), [
    catalogEvent(0, 'mnemon-run-v1-ghost'), // 目录不存在
    catalogEvent(1, 'mnemon-run-v1-keep'),  // 目录存在
  ]);
  mkdirSync(join(home, 'sessions', 'proj-a', 'mnemon-run-v1-keep'), { recursive: true });

  const r = scrubCatalogRows(home, 'session-parent-1'); // 默认 everywhere=false
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.files, [{ parentId: 'session-parent-1', removed: 1 }]);

  const lines = readLines(parentLog);
  assert.equal(JSON.parse(lines[1]).type, 'subagent-delete/retired', '残留行被退休');
  assert.equal(JSON.parse(lines[2]).type, 'subagent/catalog', '仍存在的行保留');
});

test('场景7b：scrubCatalogRows(everywhere=true) 扫全部会话日志', (t) => {
  const home = tmpHome(t);
  const dirA = sessionDir(home, 'proj-a', 'session-parent-1');
  const dirB = sessionDir(home, 'proj-b', 'session-history-1');
  const logA = writeLog(dirA, headerLine('parent-1'), [catalogEvent(0, 'ghost')]);
  const logB = writeLog(dirB, headerLine('history-1'), [catalogEvent(0, 'ghost')]);

  const r = scrubCatalogRows(home, 'session-parent-1', true);
  assert.equal(r.removed, 2);
  assert.equal(r.scanned, 2);
  assert.deepEqual(r.failed, []);
  assert.equal(r.files.length, 2);
  assert.equal(JSON.parse(readLines(logA)[1]).type, 'subagent-delete/retired');
  assert.equal(JSON.parse(readLines(logB)[1]).type, 'subagent-delete/retired');
});

// ───────────────── 必测场景 8 ─────────────────

test('场景8：encodeLog/decodeLog 往返 950 事件 → 多帧 → 951 行、header 一致、末行 seq 949', (t) => {
  const home = tmpHome(t);
  const dir = sessionDir(home, 'proj-a', 'session-big');
  const hdr = headerLine('big');
  const eventLines = [];
  for (let i = 0; i < 950; i += 1) eventLines.push(catalogEvent(i, 'c' + i));

  const buf = encodeLog(hdr, eventLines);
  // 默认 perFrame=400：header 1 帧 + ceil(950/400)=3 批 = 4 帧
  assert.equal(scanZstdFrames(buf).length, 4, '950 事件被编成多个 zstd 帧');
  assert.ok(scanZstdFrames(buf).length > 1);

  const p = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(p, buf);
  const lines = readLines(p);
  assert.equal(lines.length, 951, '1 header + 950 事件行');
  assert.equal(lines[0], hdr, 'header 一致');
  const last = JSON.parse(lines[950]);
  assert.equal(last.seq, 949, '末行 seq 949');
  assert.equal(last.data.childId, 'c949');
});

// ───────────────── 加分：其余导出函数 ─────────────────

test('加分：readPending 容错 / queueCatalogRetire 去重与自动建目录', (t) => {
  const home = tmpHome(t);
  const pp = join(home, 'nested', 'dir', 'pending.json');
  assert.deepEqual(readPending(pp), {}, '不存在返回 {}');
  mkdirSync(dirname(pp), { recursive: true });
  writeFileSync(pp, '{bad json', 'utf8');
  assert.deepEqual(readPending(pp), {}, '损坏 JSON 返回 {}');
  writeFileSync(pp, 'null', 'utf8');
  assert.deepEqual(readPending(pp), {}, 'null 返回 {}');

  queueCatalogRetire(pp, 'session-parent-1', 'ghost');
  queueCatalogRetire(pp, 'session-parent-1', 'ghost'); // 去重
  queueCatalogRetire(pp, 'session-parent-1', 'other');
  assert.deepEqual(readPending(pp), { 'session-parent-1': ['ghost', 'other'] });
});

test('加分：findSessionDirs / allSessionLogPaths / storedSessionDirNames / dropProjectionCache', (t) => {
  const home = tmpHome(t);
  const parentDir = sessionDir(home, 'proj-a', 'session-parent-1');
  const childNoLog = join(home, 'sessions', 'proj-a', 'mnemon-run-v1-child-no-log');
  mkdirSync(childNoLog, { recursive: true });
  const p = writeLog(parentDir, headerLine('parent-1'), [catalogEvent(0, 'c')]);

  assert.deepEqual(findSessionDirs(home, 'parent-1'), [parentDir]);
  assert.deepEqual(findSessionDirs(home, 'session-parent-1'), [parentDir],
    '两种拼写命中同一目录');

  const paths = allSessionLogPaths(home);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].logPath, p);
  assert.equal(paths[0].parentId, 'session-parent-1');
  assert.equal(paths[0].dir, parentDir);

  const stored = storedSessionDirNames(home);
  assert.ok(stored.has('session-parent-1'));
  assert.ok(stored.has('mnemon-run-v1-child-no-log'), '无日志的目录也算「还在」');

  const pc = projcacheDir(home);
  writeFileSync(join(pc, 'parent-1.json'), '{}');
  writeFileSync(join(pc, 'session-parent-1.json'), '{}');
  assert.equal(dropProjectionCache(home, 'parent-1'), 2);
  assert.equal(existsSync(join(pc, 'parent-1.json')), false);
  assert.equal(existsSync(join(pc, 'session-parent-1.json')), false);
  assert.equal(dropProjectionCache(home, 'parent-1'), 0);
});

test('加分：retireCatalogRow 全库退休（带前缀 childId 归一）与失败排队', (t) => {
  const home = tmpHome(t);
  const dirA = sessionDir(home, 'proj-a', 'session-parent-1');
  const dirB = sessionDir(home, 'proj-b', 'session-history-1');
  const logA = writeLog(dirA, headerLine('parent-1'), [catalogEvent(0, 'ghost')]);
  const logB = writeLog(dirB, headerLine('history-1'), [catalogEvent(0, 'ghost')]);

  // everywhere=true，childId 带 session- 前缀也应归一命中
  const r1 = retireCatalogRow(home, 'session-parent-1', 'session-ghost', null, true);
  assert.equal(r1.retired, true);
  assert.equal(r1.queued, false);
  assert.equal(r1.removed, 2);
  assert.equal(r1.result.removed, 2);
  assert.equal(JSON.parse(readLines(logA)[1]).type, 'subagent-delete/retired');
  assert.equal(JSON.parse(readLines(logB)[1]).type, 'subagent-delete/retired');

  // everywhere=false 且父日志不存在 → 明确失败 → 排队
  const pp = pendingFilePath(home);
  const r2 = retireCatalogRow(home, 'no-such-parent', 'ghost', pp, false);
  assert.equal(r2.retired, false);
  assert.equal(r2.queued, true);
  assert.equal(r2.removed, 0);
  assert.deepEqual(readPending(pp), { 'no-such-parent': ['ghost'] });
});
