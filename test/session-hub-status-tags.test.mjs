// 会话管理中心：DSH 状态标签合入标签下拉/标签云的回归测试。
// 通过 vm 执行 session-hub client IIFE，拿 __testing 纯函数钩子验证：
//   1. filterAndSort 支持状态标签筛选（与手动标签区分编码）。
//   2. buildStatusTags 从 it.status 聚合出 6 种状态标签及计数。
//   3. encode/decodeStatusTag 编解码正确、不与手动标签冲突。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));

function loadHubTesting() {
  const src = readFileSync(
    join(here, '..', 'packages', 'dsh-plugin-yanyan-session-hub', 'lib', 'client.js'),
    'utf8');
  let captured = null;
  function FakeComponent() {}
  FakeComponent.prototype = {};
  const fakeReact = {
    Component: FakeComponent,
    createElement: () => ({}),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => null,
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          const module = entry.factory((name) => (name === 'react' ? fakeReact : {}));
          captured = module.__testing;
        },
      },
    },
    document: { querySelector: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }), head: { appendChild() {} } },
    fetch: () => Promise.resolve({}),
    process: {},
    Promise, Set, Map, Object, String, Array, Date, console, JSON, Intl,
  };
  vm.runInNewContext(src, sandbox, { filename: 'dsh-plugin-yanyan-session-hub/client.js' });
  return captured;
}

const T = loadHubTesting();

test('状态标签编解码：加前缀不与手动标签冲突', () => {
  assert.ok(T && typeof T.encodeStatusTag === 'function', '应暴露 __testing.encodeStatusTag');
  const enc = T.encodeStatusTag('已归档');
  assert.equal(enc, '__status__已归档');
  assert.equal(T.decodeStatusTag(enc), '已归档');
  assert.equal(T.decodeStatusTag('已归档'), null, '手动标签名不应被当成状态标签');
  assert.equal(T.decodeStatusTag('普通标签'), null);
});

test('buildStatusTags：从 it.status 聚合 6 种状态与计数', () => {
  assert.ok(typeof T.buildStatusTags === 'function', '应暴露 __testing.buildStatusTags');
  // 跨 vm realm 的数组原型与字面量不同，deepStrictEqual 会因引用原型差异失败，改比字符串。
  assert.equal(Array.from(T.STATUS_TAGS).join(','), '已归档,进行中,空白,子会话,空闲,空会话');
  const items = [
    { id: 'a', status: ['已归档'] },
    { id: 'b', status: ['进行中', '空会话'] },
    { id: 'c', status: ['进行中'] },
    { id: 'd', status: ['空闲'] },
    { id: 'e', status: [] },
  ];
  const tags = T.buildStatusTags(items);
  assert.equal(tags.length, 6, '固定 6 个状态标签，即使计数为 0');
  const byLabel = {};
  tags.forEach((x) => { byLabel[x.label] = x.count; });
  assert.equal(byLabel['已归档'], 1);
  assert.equal(byLabel['进行中'], 2);
  assert.equal(byLabel['空会话'], 1);
  assert.equal(byLabel['空闲'], 1);
  assert.equal(byLabel['空白'], 0);
  assert.equal(byLabel['子会话'], 0);
  assert.ok(tags.every((x) => x.isStatus === true));
});

test('filterAndSort：状态标签筛选匹配 it.status，手动标签筛选匹配 it.tags', () => {
  const items = [
    { id: 's1', title: 'A', updatedAt: 0, status: ['已归档'], tags: ['项目X'] },
    { id: 's2', title: 'B', updatedAt: 0, status: ['进行中'], tags: ['项目Y'] },
    { id: 's3', title: 'C', updatedAt: 0, status: ['空闲'], tags: ['项目X'] },
    { id: 's4', title: 'D', updatedAt: 0, status: ['进行中', '空会话'], tags: [] },
  ];
  const byStatus = T.filterAndSort(items, '', '__all__', T.encodeStatusTag('进行中'), 'updatedDesc');
  assert.deepEqual(byStatus.map((x) => x.id).sort(), ['s2', 's4'], '状态筛选应命中 status 含「进行中」的行');
  const byStatusEmpty = T.filterAndSort(items, '', '__all__', T.encodeStatusTag('空会话'), 'updatedDesc');
  assert.deepEqual(byStatusEmpty.map((x) => x.id), ['s4']);
  const byStatusArchived = T.filterAndSort(items, '', '__all__', T.encodeStatusTag('已归档'), 'updatedDesc');
  assert.deepEqual(byStatusArchived.map((x) => x.id), ['s1']);
  const byManual = T.filterAndSort(items, '', '__all__', '项目X', 'updatedDesc');
  assert.deepEqual(byManual.map((x) => x.id).sort(), ['s1', 's3'], '手动标签筛选仍按 it.tags 匹配');
  const byStatusNone = T.filterAndSort(items, '', '__all__', T.encodeStatusTag('子会话'), 'updatedDesc');
  assert.equal(byStatusNone.length, 0, '无匹配状态应返回空');
});

test('buildStatusTags：回收站按自身条目聚合，计数不串到会话栏（m03049）', () => {
  // 回归：TrashPage 曾用会话栏全量 statusTags（buildStatusTags(ui.items)），
  // 导致回收站下拉计数与会话栏完全一致。修复后 TrashPage 内部改用
  // buildStatusTags(items=trashItems)，两组数据应得到不同计数。
  const sessionItems = [
    { id: 's1', status: ['已归档'] },
    { id: 's2', status: ['进行中'] },
    { id: 's3', status: ['空闲'] },
  ];
  const trashItems = [
    { id: 't1', status: ['已归档'] },
    { id: 't2', status: ['已归档'] },
    { id: 't3', status: ['空会话'] },
  ];
  const count = (tags, label) => {
    const found = tags.filter((x) => x.label === label)[0];
    return found ? found.count : -1;
  };
  const sessionTags = T.buildStatusTags(sessionItems);
  const trashTags = T.buildStatusTags(trashItems);
  assert.equal(count(sessionTags, '已归档'), 1);
  assert.equal(count(trashTags, '已归档'), 2, '回收站已归档计数应来自回收站自身条目');
  assert.equal(count(sessionTags, '空会话'), 0);
  assert.equal(count(trashTags, '空会话'), 1);
  assert.notEqual(count(sessionTags, '已归档'), count(trashTags, '已归档'),
    '两组数据源的计数必须不同，证明下拉不再共用会话栏统计');
});
