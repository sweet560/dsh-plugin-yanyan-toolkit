// dsh-plugin-yanyan-subagent / test/hidden-ids.test.mjs
//
// 回归：官方「N 个子智能体」浮层只读 client 内存 store
// `projectionsBySession[*].values.subagentCatalog`，宿主对已加载的 live 父会话
// 复用内存 fold state —— 改磁盘日志 / 删 projcache 都不会让它重算，这就是残留行
// 「磁盘已干净却仍显示」的根因。修复 = host 扫全库日志里的
// `subagent-delete/retired` 收集已退休 childId，经 /config 下发，client 据此
// 持续过滤内存投影。本测试覆盖这条链路的纯函数部分。
//
// 全部用 os.tmpdir 造临时 DSH_HOME，绝不触碰真实运行时目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeLog } from '../lib/zstd-frames.js';
import { collectRetiredIds, logCoreId } from '../lib/log-rewrite.js';
import { collectHiddenIds, legacyHiddenIds } from '../lib/index.js';

function tmpHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'yanyan-hidden-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function headerLine(id) {
  return JSON.stringify({ type: 'session', version: 4, id: 'session-' + id });
}

function retiredEvent(seq, childId) {
  return JSON.stringify({
    type: 'subagent-delete/retired', seq, time: 1000 + seq,
    ignorable: true, data: { childId, retiredAt: 1700000000000 },
  });
}

function catalogEvent(seq, childId) {
  return JSON.stringify({
    type: 'subagent/catalog', seq, time: 1000 + seq,
    data: { version: 3, childId, childCreatedAt: seq, mode: 'continuable', name: 'N' },
  });
}

function writeLog(dshHome, slug, parentId, eventLines) {
  const dir = join(dshHome, 'sessions', slug, parentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'),
    encodeLog(headerLine(parentId), eventLines));
}

test('collectRetiredIds 扫全库 zstd 日志，只收集退休行的 childId', (t) => {
  const home = tmpHome(t);
  writeLog(home, 'slug-a', 'session-parent-1', [
    retiredEvent(1, 'child-a'),
    catalogEvent(2, 'child-alive'),           // 仍会显示，不能收集
    retiredEvent(3, 'session-child-b'),       // 带 session- 前缀 → 归一
  ]);
  writeLog(home, 'slug-b', 'session-parent-2', [
    retiredEvent(1, 'child-c'),
    retiredEvent(2, 'child-a'),               // 跨目录去重
  ]);
  writeLog(home, 'slug-c', 'session-parent-3', [
    catalogEvent(1, 'child-x'),               // 无退休标记，整份跳过
  ]);

  const ids = collectRetiredIds(home).sort();
  assert.deepEqual(ids, ['child-a', 'child-b', 'child-c']);
  // 仍活跃的 catalog 条目与无退休日志都不该出现在清单里。
  assert.ok(!ids.includes('child-alive'));
  assert.ok(!ids.includes('child-x'));
});

test('collectRetiredIds 对空 / 损坏 DSH_HOME 安全返回空数组', (t) => {
  const home = tmpHome(t);
  assert.deepEqual(collectRetiredIds(home), []);
  // 损坏的 zstd 文件被 decodeLog 抛错后 continue，不拖垮整库扫描。
  const dir = join(home, 'sessions', 'bad', 'session-bad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not-zstd'));
  assert.deepEqual(collectRetiredIds(home), []);
});

test('collectHiddenIds = legacyHiddenIds ∪ 全库已退休 id，去重且归一', (t) => {
  const home = tmpHome(t);
  const legacy = legacyHiddenIds();
  assert.ok(Array.isArray(legacy) && legacy.length > 0, '迁移清单应随包发布');
  writeLog(home, 'slug', 'session-p', [
    retiredEvent(1, legacy[0]),                       // 与迁移清单重复
    retiredEvent(2, 'session-new-retired'),           // 新增 + 前缀归一
  ]);

  const hidden = collectHiddenIds(home);
  // 去重：legacy 里同一 id 只出现一次。
  assert.equal(hidden.filter((x) => x === legacy[0]).length, 1);
  // 归一：带 session- 前缀的退休 id 以核心 id 形式下发。
  assert.ok(hidden.includes('new-retired'));
  assert.ok(!hidden.includes('session-new-retired'));
  // legacy 其余条目仍在。
  for (const id of legacy) assert.ok(hidden.includes(id));
  // 空 DSH_HOME 时退化为纯迁移清单，不抛错。
  assert.deepEqual(collectHiddenIds('').sort(), [...legacy].sort());
});

test('logCoreId 与 collectRetiredIds 对 catalog 投影条目 id 的归一一致', (t) => {
  const home = tmpHome(t);
  writeLog(home, 'slug', 'session-p', [retiredEvent(1, 'session-abc')]);
  const ids = collectRetiredIds(home);
  assert.deepEqual(ids, ['abc']);
  assert.equal(logCoreId('session-abc'), 'abc');
});
