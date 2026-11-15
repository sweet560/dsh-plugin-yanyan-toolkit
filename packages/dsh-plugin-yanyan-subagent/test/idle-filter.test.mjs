import test from 'node:test';
import assert from 'node:assert/strict';
import { idleFilter } from '../lib/index.js';

const now = 1_000_000_000;
const rows = [
  { kind: 'child', id: 'root', activity: 'inactive' },          // rootId 排除
  { kind: 'child', id: 'idle-old', activity: 'inactive' },      // 超过阈值，命中
  { kind: 'child', id: 'idle-new', activity: 'inactive' },      // 未超过阈值
  { kind: 'child', id: 'run', activity: 'running' },            // running 排除
  { kind: 'diagnostic', id: 'diag', reason: 'corrupt' },        // diagnostic 排除
  { kind: 'child', id: 'idle-exact', activity: 'inactive' },    // 恰好等于阈值，命中
  { kind: 'child', id: 'weird' },                               // 无 activity，排除
];

const since = (id) => {
  if (id === 'idle-old') return now - 31 * 60_000;
  if (id === 'idle-exact') return now - 30 * 60_000;
  return now;
};

test('idleFilter：仅选 inactive 且超过阈值的行（边界值恰好命中）', () => {
  const got = idleFilter(rows, { rootId: 'root', idleMinutes: 30, now, idleSince: since });
  assert.deepEqual(got.map((r) => r.id), ['idle-old', 'idle-exact']);
});

test('idleFilter：排除 running、diagnostic、无 activity 与 rootId（idleMinutes<=0 不按阈值过滤）', () => {
  const got = idleFilter(rows, {
    rootId: 'root', idleMinutes: 0, now, idleSince: () => now - 99_999_999,
  });
  assert.deepEqual(got.map((r) => r.id), ['idle-old', 'idle-new', 'idle-exact']);
});

test('idleFilter：默认 idleSince 为 now，阈值内不命中；rows 非数组返回空', () => {
  const got = idleFilter(rows, { rootId: 'root', idleMinutes: 30, now });
  assert.deepEqual(got, []);
  assert.deepEqual(idleFilter(null, { idleMinutes: 30, now }), []);
  assert.deepEqual(idleFilter('x', { idleMinutes: 30, now }), []);
});

test('idleFilter：非法 idleMinutes / now 时回落到默认阈值与 Date.now', () => {
  const got = idleFilter([rows[1]], { idleMinutes: 'x', now: NaN, idleSince: () => 0 });
  // 非法 now 回落 Date.now()，idleSince=0 远早于阈值，故命中。
  assert.deepEqual(got.map((r) => r.id), ['idle-old']);
});
