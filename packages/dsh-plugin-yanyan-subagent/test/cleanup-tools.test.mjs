// dsh-plugin-yanyan-subagent / test/cleanup-tools.test.mjs
//
// 对 host lib/index.js 的 black-box 单测：只测通过 import 真正能拿到的导出。
// 读 lib/index.js 后确认：三个模型工具工厂 makeListTool / makeDeleteTool /
// makeCleanupTool，以及 renderJson / OUTPUT_SCHEMA / callerSessionId /
// isRunningSubagent 都是「非 export」的内部函数（function 声明，无 export），
// 因此按任务约束「若未导出，跳过」——不用 hack 手段提取，也不臆测其形状，
// 仅用一条 black-box 断言记录它们确实不在导出面上。
//
// index.js 中「已导出」的纯函数（供测试导入）：normalizeConfig、parseCatalog、
// idleFilter、isSafeSessionId、coreId、spellings、isVirtualId、isInside、
// stripCatalogEntries、catalogFilePath、resolveDshHome、purgePhysical、
// legacyHiddenIds、performPurge、makeDeleteHandler、makeCatalogHandler、
// makeScrubHandler、runCleanup、makeCleanupHandler、apply。
// 本文件聚焦其中不依赖 DSH 运行时的纯函数与导出面事实。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href);
const {
  normalizeConfig, parseCatalog, idleFilter, isSafeSessionId, coreId,
  spellings, isVirtualId, stripCatalogEntries, catalogFilePath,
  CONFIG_DEFAULTS,
} = mod;

test('导出面：三个模型工具工厂与 render 辅助函数未导出（按约定跳过其形状测试）', () => {
  // 任务：重点确认三个模型工具定义；若未导出则跳过，不得 hack 提取。
  for (const name of [
    'makeListTool', 'makeDeleteTool', 'makeCleanupTool',
    'renderJson', 'OUTPUT_SCHEMA', 'callerSessionId', 'isRunningSubagent',
  ]) {
    assert.equal(mod[name], undefined, `${name} 应为内部函数、不在导出面上`);
  }
  // readCatalogEvents 只是 index.js 内部 import，未 re-export 成别名。
  assert.equal(mod.readCatalogEvents, undefined);
  // 对照组：这些确实已导出且可 black-box 拿到。
  for (const name of ['runCleanup', 'performPurge', 'apply', 'normalizeConfig', 'idleFilter']) {
    assert.equal(typeof mod[name], 'function', `${name} 应导出为 function`);
  }
});

test('normalizeConfig：缺省兜底、去空白、超长截断、越界回落', () => {
  assert.deepEqual(normalizeConfig(), {
    tabLabel: '智能体管理', autoCleanEnabled: true, idleMinutes: 30,
    checkIntervalMin: 10, labelMaxLength: 24,
  });
  assert.deepEqual(normalizeConfig({}), normalizeConfig());
  const c = normalizeConfig({
    tabLabel: '  My Tab  ', autoCleanEnabled: true, idleMinutes: 5, checkIntervalMin: 2,
  });
  assert.equal(c.tabLabel, 'My Tab');
  assert.equal(c.autoCleanEnabled, true);
  assert.equal(c.idleMinutes, 5);
  assert.equal(c.checkIntervalMin, 2);
  assert.equal(c.labelMaxLength, CONFIG_DEFAULTS.labelMaxLength);
  // 越界回落默认（代码 lib/index.js:76 / :81）
  assert.equal(normalizeConfig({ idleMinutes: 99999 }).idleMinutes, 30);
  assert.equal(normalizeConfig({ idleMinutes: 0 }).idleMinutes, 30);
  assert.equal(normalizeConfig({ checkIntervalMin: 99999 }).checkIntervalMin, 10);
  assert.equal(normalizeConfig({ tabLabel: 'X'.repeat(30) }).tabLabel.length, 24);
  assert.equal(normalizeConfig({ tabLabel: '   ' }).tabLabel, '智能体管理');
});

test('idleFilter：仅 inactive、排除 diagnostic/running/rootId、按空闲阈值筛选', () => {
  const rows = [
    { id: 'a', activity: 'inactive', kind: 'child' },
    { id: 'b', activity: 'running' },
    { id: 'c', activity: 'inactive', kind: 'diagnostic' },
    { id: 'root', activity: 'inactive' },
    { id: 'd', activity: 'inactive' },
  ];
  const out = idleFilter(rows, {
    now: 1_000_000, rootId: 'root', idleMinutes: 1, idleSince: () => 0,
  });
  assert.deepEqual(out.map((r) => r.id), ['a', 'd']);
  // idleMinutes<=0 不按阈值过滤（代码 lib/index.js:118）
  const out2 = idleFilter(rows, {
    now: 100, rootId: 'root', idleMinutes: 0, idleSince: () => 100,
  });
  assert.deepEqual(out2.map((r) => r.id), ['a', 'd']);
  assert.deepEqual(idleFilter(null, {}), []);
});

test('coreId / spellings / isVirtualId：两种拼写与 mnemon 虚拟委派', () => {
  assert.equal(coreId('abc'), 'abc');
  assert.equal(coreId('session-abc'), 'abc');
  assert.deepEqual(spellings('session-abc'), ['abc', 'session-abc']);
  assert.equal(isVirtualId('mnemon-run-v1-debd95cd'), true);
  assert.equal(isVirtualId('session-mnemon-task-v1-0886a34a'), true);
  assert.equal(isVirtualId('session-f2d52ae9'), false);
  assert.equal(isVirtualId('agent-1'), false);
});

test('isSafeSessionId：拒绝路径穿越与非字符串', () => {
  assert.equal(isSafeSessionId('session-abc'), true);
  assert.equal(isSafeSessionId('mnemon-run-v1-abc'), true);
  assert.equal(isSafeSessionId('../etc'), false);
  assert.equal(isSafeSessionId('a/b'), false);
  assert.equal(isSafeSessionId('..'), false);
  assert.equal(isSafeSessionId(''), false);
  assert.equal(isSafeSessionId(123), false);
});

test('parseCatalog：收敛数组 / entries / rows / 非法输入', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  assert.deepEqual(parseCatalog([a, b]), [a, b]);
  assert.deepEqual(parseCatalog({ entries: [a] }), [a]);
  assert.deepEqual(parseCatalog({ rows: [b] }), [b]);
  for (const raw of [null, undefined, 0, '', {}, { entries: 'x' }]) {
    assert.deepEqual(parseCatalog(raw), []);
  }
});

test('stripCatalogEntries：递归剔除 head/previous 命中条目、返回 changed/removed', () => {
  const rec = {
    record: { rows: { subagentCatalog: { val: { head: {
      values: [{ childId: 'keep' }, { childId: 'ghost' }, { id: 'session-ghost' }],
      previous: { values: [{ childId: 'old' }, { id: 'ghost' }], previous: null },
    } } } } },
  };
  const r = stripCatalogEntries(rec, ['ghost']);
  assert.equal(r.changed, true);
  assert.equal(r.removed, 3);
  assert.deepEqual(rec.record.rows.subagentCatalog.val.head.values, [{ childId: 'keep' }]);
  assert.deepEqual(rec.record.rows.subagentCatalog.val.head.previous.values, [{ childId: 'old' }]);
  assert.deepEqual(stripCatalogEntries(rec, ['none']), { changed: false, removed: 0 });
  assert.deepEqual(stripCatalogEntries({}, ['ghost']), { changed: false, removed: 0 });
});

test('catalogFilePath：带 / 不带 session- 前缀指向同一文件', () => {
  const a = catalogFilePath('/home', 'abc');
  const b = catalogFilePath('/home', 'session-abc');
  assert.equal(a, b);
  assert.ok(a.includes('session-abc.json'));
});
