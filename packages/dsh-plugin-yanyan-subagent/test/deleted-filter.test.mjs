// 校验 client 侧「已删除 id 隐藏清单」的关键纯逻辑：coreId 归一化 +
// filterDeleted 过滤。client.js 是浏览器 IIFE，无法直接 import，因此这里
// 从源码里静态提取 helpers 区块，放进最小沙箱执行。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

// 从 `function readLS` 到 `function updateIdleTracking` 之前，是一组互相依赖、
// 但不依赖浏览器 DOM 的纯 helpers（含 localStorage 读写、隐藏清单、空闲筛选）。
function extractHelpers() {
  const start = source.indexOf('      function readLS(key)');
  const end = source.indexOf('      // 空闲起点：', start);
  assert.ok(start >= 0 && end > start, '源码 helpers 区块边界未找到');
  return source.slice(start, end);
}

function sandbox(deletedArray) {
  const store = { 'yanyan-subagent.deletedIds': JSON.stringify(deletedArray) };
  const ctx = {
    LS_DELETED: 'yanyan-subagent.deletedIds',
    DEFAULT_TAB_LABEL: '智能体管理',
    LS_LABEL: 'yanyan-subagent.tabLabel',
    LS_AUTO: 'yanyan-subagent.autoCleanEnabled',
    LS_IDLE: 'yanyan-subagent.idleMinutes',
    LS_INTERVAL: 'yanyan-subagent.checkIntervalMin',
    clampInt: (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) && Math.floor(n) >= min && Math.floor(n) <= max ? Math.floor(n) : fallback;
    },
    root: {
      localStorage: {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      },
    },
  };
  const code = extractHelpers()
    + '\n;({coreId, readDeletedIds, writeDeletedIds, markDeleted, isDeleted, filterDeleted})';
  const api = vm.runInNewContext(code, ctx, { filename: 'client-helpers.js' });
  return { api, store };
}

// vm 返回的数组来自另一个 realm，先转成宿主 realm 再断言。
function plain(v) { return JSON.parse(JSON.stringify(v)); }

test('coreId 归一化：去掉 session- 前缀，两种写法同键', () => {
  const { api } = sandbox([]);
  assert.equal(api.coreId('d62abba7-468b'), 'd62abba7-468b');
  assert.equal(api.coreId('session-d62abba7-468b'), 'd62abba7-468b');
  assert.equal(api.coreId('mnemon-run-v1-abc'), 'mnemon-run-v1-abc');
  assert.equal(api.coreId('session-mnemon-run-v1-abc'), 'mnemon-run-v1-abc');
  assert.equal(api.coreId(''), '');
});

test('markDeleted 写入清单后 isDeleted 对两种拼写都命中', () => {
  const { api, store } = sandbox([]);
  assert.equal(api.isDeleted('session-foo'), false);
  api.markDeleted('foo');
  assert.equal(api.isDeleted('foo'), true);
  assert.equal(api.isDeleted('session-foo'), true, '带前缀写法也必须命中');
  api.markDeleted('session-foo');
  assert.equal(plain(JSON.parse(store['yanyan-subagent.deletedIds'])).length, 1, '重复写入应去重');
});

test('filterDeleted 从 catalog 行里剔除已删除 id（id 与 childId 两种字段）', () => {
  const { api } = sandbox(['gone-1']);
  const rows = [
    { id: 'gone-1', label: 'A' },
    { id: 'session-gone-1', label: 'A2' },
    { childId: 'session-gone-1', label: 'A3' },
    { id: 'keep-1', label: 'B' },
    { kind: 'diagnostic', reason: 'corrupt' },
    null,
  ];
  const out = plain(api.filterDeleted(rows));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.id || r.kind), ['keep-1', 'diagnostic']);
});

test('隐藏清单损坏或超限时安全降级，不抛错', () => {
  const bad = sandbox([]);
  bad.store['yanyan-subagent.deletedIds'] = '{not json';
  assert.deepEqual(plain(bad.api.readDeletedIds()), []);
  const many = sandbox(Array.from({ length: 600 }, (_, i) => 'id-' + i));
  many.api.markDeleted('id-999');
  assert.ok(plain(JSON.parse(many.store['yanyan-subagent.deletedIds'])).length <= 500, '清单应有上限');
});
