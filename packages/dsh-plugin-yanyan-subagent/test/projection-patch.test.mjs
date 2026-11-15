// 校验本次 BUG 根治的核心逻辑：client 侧 patchProjections 把持久化隐藏清单
// 应用到官方浮层唯一数据源 `projectionsBySession[*].values.subagentCatalog`。
//
// 复用 deleted-filter.test.mjs 的基建（不重复造轮子）：client.js 是浏览器
// IIFE，patchProjections 不导出，因此从源码静态提取 helpers 区块，放进最小
// vm 沙箱真实执行。切片边界与 deleted-filter 完全一致（readLS → 空闲起点），
// patchProjections(@273-311) 落在该区块内。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
const hiddenIds = JSON.parse(
  readFileSync(join(here, '..', 'lib', 'legacy-hidden-ids.json'), 'utf8'),
).ids.map((x) => String(x).replace(/^session-/, ''));

function extractHelpers() {
  const start = source.indexOf('      function readLS(key)');
  const end = source.indexOf('      // 空闲起点：', start);
  assert.ok(start >= 0 && end > start, '源码 helpers 区块边界未找到');
  return source.slice(start, end);
}

// vm 返回的数组/对象来自另一个 realm，先转成宿主 realm 再断言。
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function sandbox(deletedArray, snapshot) {
  const store = { 'yanyan-subagent.deletedIds': JSON.stringify(deletedArray) };
  const calls = [];
  let current = snapshot;
  const list = {
    getSnapshot: () => current,
    set: (next) => { calls.push(next); current = next; },
  };
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
    + '\n;({coreId, readDeletedIds, writeDeletedIds, markDeleted, isDeleted, filterDeleted, patchProjections})';
  const api = vm.runInNewContext(code, ctx, { filename: 'client-helpers.js' });
  return { api, store, calls, list, getSnapshot: () => current };
}

// 造一份贴近宿主的 SessionListState 快照。
function makeSnapshot(catalogBySid) {
  const projectionsBySession = {};
  for (const [sid, catalog] of Object.entries(catalogBySid)) {
    projectionsBySession[sid] = {
      state: 'ready',
      error: null,
      values: {
        title: '父会话 ' + sid,
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 20 },
        subagentCatalog: catalog,
      },
    };
  }
  return {
    ids: Object.keys(projectionsBySession),
    byId: {},
    phase: 'ready',
    projectionsBySession,
  };
}

function mockCtx(list) {
  return { sessions: { list } };
}

test('patchProjections 从内存投影剔除隐藏 id，保留其它条目/投影键/顶层字段', () => {
  const gone = 'mnemon-run-v1-2e7c7461-1d43-4abb-a5f2-71ea29159808';
  const gone2 = 'mnemon-run-v1-3ca1a5c0-b695-4241-9a19-981fd67524bb';
  const snap = makeSnapshot({
    'session-parent': [
      { id: gone, mode: 'continuable', name: 'A' },
      { id: 'keep-1', mode: 'external', name: 'B' },
      { childId: 'session-' + gone2, name: 'C' }, // childId 字段 + session- 前缀
      { id: 'keep-2', name: 'D' },
    ],
    'session-other': [
      { id: 'keep-3', name: 'E' },
    ],
  });
  const { api, calls, list } = sandbox([gone, gone2], snap);

  api.patchProjections(mockCtx(list));

  assert.equal(calls.length, 1, '仅当发现命中时才写回一次');
  const next = plain(calls[0]);
  const parent = next.projectionsBySession['session-parent'];
  assert.deepEqual(
    parent.values.subagentCatalog.map((e) => e.id || e.childId),
    ['keep-1', 'keep-2'],
    '命中的 2 行（含 childId/session- 前缀写法）必须被剔除',
  );
  assert.equal(parent.state, 'ready', 'state 保留');
  assert.equal(parent.error, null, 'error 保留');
  assert.equal(parent.values.title, '父会话 session-parent', 'values 里其它投影键保留');
  assert.deepEqual(parent.values.tokenUsage, { uncachedInputTokens: 100, outputTokens: 20 });
  assert.deepEqual(next.projectionsBySession['session-other'].values.subagentCatalog, [{ id: 'keep-3', name: 'E' }],
    '无命中的会话不应被改写');
  assert.deepEqual(next.ids, ['session-parent', 'session-other'], '顶层 ids 保留');
  assert.equal(next.phase, 'ready', '顶层 phase 保留');
});

test('patchProjections 幂等收敛：写回后再调用不再 set，不会自激循环', () => {
  const gone = 'mnemon-run-v1-28354b4a-4859-4c8e-aebd-e9281f13bde4';
  const snap = makeSnapshot({
    'session-parent': [
      { id: gone, name: 'A' },
      { id: 'keep-1', name: 'B' },
    ],
  });
  const { api, calls, list, getSnapshot } = sandbox([gone], snap);

  api.patchProjections(mockCtx(list)); // 第一次：剔除 + set
  assert.equal(calls.length, 1);
  // 模拟宿主 subscribe 再次触发（用已写回的干净快照）
  api.patchProjections(mockCtx(list));
  assert.equal(calls.length, 1, '已无命中，不应再次 set');
  assert.equal(plain(getSnapshot()).projectionsBySession['session-parent'].values.subagentCatalog.length, 1);
});

test('patchProjections 边界安全：无清单/无 list/无 projections/catalog 非数组都不抛错且不 set', () => {
  // 1) 隐藏清单为空
  {
    const snap = makeSnapshot({ 'session-parent': [{ id: 'gone', name: 'A' }] });
    const { api, calls, list } = sandbox([], snap);
    api.patchProjections(mockCtx(list));
    assert.equal(calls.length, 0, '无隐藏清单直接 return');
  }
  // 2) ctx 无 sessions.list
  {
    const { api, calls } = sandbox(['gone'], makeSnapshot({}));
    assert.doesNotThrow(() => api.patchProjections({}));
    assert.equal(calls.length, 0);
  }
  // 3) 快照无 projectionsBySession / catalog 不是数组
  {
    const { api, calls, list } = sandbox(['gone'], { ids: [], byId: {}, phase: 'ready' });
    const ctx = mockCtx(list);
    assert.doesNotThrow(() => api.patchProjections(ctx));
    assert.equal(calls.length, 0);
    list.set = () => { throw new Error('should-not-set'); };
    api.patchProjections(mockCtx({
      getSnapshot: () => ({ projectionsBySession: { s: { values: { subagentCatalog: 'not-array' } } } }),
      set: () => { throw new Error('should-not-set'); },
    }));
  }
});

test('真实回归：图1 的 7 个残留 id 配合扩充后的 legacy-hidden-ids.json 全部剔除，directCount 归零', () => {
  // 图1/诊断3 确认的 7 个「磁盘已退休但内存仍显示」的 childId。
  const seven = [
    'mnemon-run-v1-2e7c7461-1d43-4abb-a5f2-71ea29159808',
    'mnemon-run-v1-3ca1a5c0-b695-4241-9a19-981fd67524bb',
    'mnemon-run-v1-28354b4a-4859-4c8e-aebd-e9281f13bde4',
    'mnemon-run-v1-be28ac2b-5cb7-4fbe-8243-834b2196fdf9',
    'mnemon-run-v1-3681c2e1-10f8-4b69-a270-13a2cbb319ec',
    'mnemon-run-v1-0b3db3e5-b6f0-4d74-82f5-124822a15c53',
    'mnemon-run-v1-ffbcb086-9796-425c-a6d8-26ce7d1209ea',
  ];
  // 扩充后的迁移清单必须覆盖全部 7 个（这是旧 host 进程即时下发的兼容桥）。
  for (const id of seven) {
    assert.ok(hiddenIds.includes(id), 'legacy-hidden-ids.json 必须包含 ' + id);
  }
  const snap = makeSnapshot({
    'session-4c30d061-c711-40cc-b866-d00fa70ba546': seven.map((id, i) => ({
      id, mode: 'continuable', name: 'agent-' + (i + 1),
    })),
  });
  const { api, calls, list } = sandbox(hiddenIds, snap);

  api.patchProjections(mockCtx(list));

  const catalog = plain(calls[0]).projectionsBySession['session-4c30d061-c711-40cc-b866-d00fa70ba546'].values.subagentCatalog;
  assert.equal(catalog.length, 0, '官方浮层 directCount 归零 → visible=false 自动隐藏');
  assert.equal(hiddenIds.length, 24, '扩充后的全集应为 24 个（4 迁移 ∪ 20 全库已退休）');
});
