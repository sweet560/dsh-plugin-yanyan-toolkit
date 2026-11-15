// dsh-plugin-yanyan-subagent / test/portal-interaction.test.mjs
//
// 回归：修复用户反馈「点击清理全部空闲按钮没反应，点击设置和重命名标签的框均直接退出」。
// 两个根因：
//   1) makeActionButton 把 createPortal 当作 <button> 的 children，React 合成事件沿
//      fiber 树上溯到 button，触发 onClick -> setOpen(!v) 把浮层 toggle 卸载；
//   2) cleanAllIdle 套用「inactive + 30 分钟阈值」，而官方 catalog 无 idleSince、
//      客户端 firstSeen 刚起步，几乎永远 0 命中，且判定与列表「空闲」标签不一致。
//
// 不重复造轮子：沿用 projection-patch.test.mjs / deleted-filter.test.mjs 的
// 「从浏览器 IIFE 源码提取函数 + vm 真实执行」思路；React 结构修复无 DOM 环境，
// 改用源码契约断言（提取函数体后做正则 / 子串断言），不臆测宿主运行时。
//
// client.js 是浏览器脚本（__ModuleLoader__ IIFE），node 无法直接 import，因此：
//   - 纯函数（manualCleanTargets / coreId）用花括号配对提取后在 vm 里真实执行；
//   - 组件 / 字典结构用静态契约断言锁定修复形态。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

// 花括号配对提取一个具名函数声明（可含内嵌 function(){} / 对象字面量 {}）。
// 本文件提取的函数体内字符串不含花括号，简单计数即可正确配对。
function extractFn(src, name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `找不到函数声明 ${name}`);
  const open = src.indexOf('{', start);
  assert.ok(open > start, `${name} 找不到函数体起始 {`);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > open, `${name} 花括号未配对`);
  return src.slice(start, end);
}

function loadManualClean() {
  const code = extractFn(source, 'coreId') + '\n'
    + extractFn(source, 'manualCleanTargets') + '\n'
    + '\n;({ manualCleanTargets })';
  return vm.runInNewContext(code, {}, { filename: 'client-manual-clean.js' });
}

// vm 返回的数组来自另一个 realm，先转回宿主 realm 再断言
// （与 projection-patch.test.mjs 的 plain() 同一处理，不重复造轮子）。
function ids(out) { return JSON.parse(JSON.stringify(out.map((r) => r.id))); }

// ───────────────── Fix 2 行为：manualCleanTargets 真实执行 ─────────────────

test('manualCleanTargets：清掉所有非 running 的条目（含无 activity 字段、列表显示为空闲的行）', () => {
  const { manualCleanTargets } = loadManualClean();
  const rows = [
    { id: 'a-inactive', activity: 'inactive' },
    { id: 'b-idle-word', activity: 'idle' },
    { id: 'c-no-activity', kind: 'child' },          // 列表显示「空闲」，旧逻辑要求 inactive 故清不掉
    { id: 'd-running', activity: 'running' },
    { id: 'e-diag', activity: 'inactive', kind: 'diagnostic' },
    { id: 'root', activity: 'inactive' },
    { id: 'session-root', activity: 'inactive' },    // 带前缀的 root 也要归一化排除
    null,
    'not-an-object',
    [1, 2],
    { activity: 'inactive' },                        // 无 id 跳过（避免选中却删不掉）
  ];
  const out = manualCleanTargets(rows, { rootId: 'root' });
  assert.deepEqual(ids(out), ['a-inactive', 'b-idle-word', 'c-no-activity']);
});

test('manualCleanTargets：isHidden 双保险剔除隐藏清单里的 id（含 session- 前缀）', () => {
  const { manualCleanTargets } = loadManualClean();
  const rows = [
    { id: 'keep', activity: 'inactive' },
    { id: 'gone', activity: 'inactive' },
    { id: 'session-gone2', activity: 'inactive', childId: 'gone2' },
  ];
  const hidden = ['gone', 'gone2'];
  const out = manualCleanTargets(rows, {
    isHidden: (id) => hidden.indexOf(String(id).replace(/^session-/, '')) !== -1,
  });
  assert.deepEqual(ids(out), ['keep']);
});

test('manualCleanTargets：非法输入与未传 isHidden 都安全（不抛错、默认不过滤）', () => {
  const { manualCleanTargets } = loadManualClean();
  assert.deepEqual(ids(manualCleanTargets(null, {})), []);
  assert.deepEqual(ids(manualCleanTargets(undefined)), []);
  assert.deepEqual(ids(manualCleanTargets([{ id: 'x', activity: 'inactive' }])), ['x']);
  // 无 rootId 时 root 行不再被排除（调用方总会传 shared.rootId）。
  assert.deepEqual(ids(manualCleanTargets([{ id: 'root', activity: 'inactive' }])), ['root']);
});

// ───────────────── Fix 1 源码契约：React Portal 事件冒泡 ─────────────────

test('Fix 1：makeActionButton 用 React.Fragment 让 button 与 portal 成为兄弟', () => {
  const fn = extractFn(source, 'makeActionButton');
  // 缺少 Fragment 时必须退回纯 DOM 降级，不能复发冒泡 bug。
  assert.match(source, /React\.useRef && React\.Fragment/, 'canReact 应要求 React.Fragment');
  assert.match(fn, /React\.createElement\(React\.Fragment, null, tabBtn, portal\)/,
    '必须用 Fragment 并列返回 tabBtn + portal（断开 fiber 上溯到 button 的链）');
  assert.ok(!/kids\.push\(/.test(fn), '不得再把 portal push 进 button 的 children');
  assert.match(fn, /ReactDOM\.createPortal\(/, 'portal 仍通过 createPortal 渲染');
  assert.match(fn, /doc\.body/, 'portal 容器仍是 document.body（DOM 位置与样式不变）');
});

test('Fix 1 双保险：PortalHost 的 div 对 pointer/click/touch 事件 stopPropagation', () => {
  const fn = extractFn(source, 'PortalHost');
  assert.match(fn, /stopPropagation/, '必须有 stopPropagation 截断合成事件');
  for (const key of ['onClick: swallow', 'onMouseDown: swallow', 'onPointerDown: swallow', 'onTouchStart: swallow']) {
    assert.ok(fn.includes(key), `PortalHost 缺少 ${key}`);
  }
  // 绝不能 preventDefault，否则输入框无法聚焦 / 勾选 / 点击失效。
  assert.ok(!/preventDefault\(\)/.test(fn), 'swallow 不应调用 preventDefault');
});

// ───────────────── Fix 2 源码契约：手动清理不套阈值 ─────────────────

test('Fix 2：cleanAllIdle 用 manualCleanTargets 且不再套 idleMinutes 阈值', () => {
  const fn = extractFn(source, 'cleanAllIdle');
  assert.match(fn, /manualCleanTargets\(/, '手动清理必须调用 manualCleanTargets');
  assert.ok(!/idleFilterLocal\s*\(/.test(fn), '手动清理不得再套 idleFilterLocal（阈值）');
  assert.match(fn, /t\('cleanNoIdle'\)/, '0 命中要给出明确提示');
});

test('阈值仍只约束自动清理：autoCleanTick 保留 idleFilterLocal + idleMinutes', () => {
  const fn = extractFn(source, 'autoCleanTick');
  assert.match(fn, /idleFilterLocal\(/, '自动清理仍按阈值筛选');
  assert.match(fn, /idleMinutes:/, '自动清理仍使用 idleMinutes');
});

// ───────────────── 字典契约 ─────────────────

function dictKeys(name) {
  const start = source.indexOf('var ' + name + ' = {');
  assert.ok(start >= 0, `找不到字典 ${name}`);
  const end = source.indexOf('\n      };', start);
  assert.ok(end > start, `${name} 字典结束标记未找到`);
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]).sort();
}

test('UI_zh / UI_en 键集一致（含新增 cleanNoIdle / manualCleanHint）', () => {
  const zh = dictKeys('UI_zh');
  const en = dictKeys('UI_en');
  assert.deepEqual(en, zh, 'en 必须与 zh 逐键对照（ctx.locale.register 契约）');
  assert.ok(zh.includes('cleanNoIdle'));
  assert.ok(zh.includes('manualCleanHint'));
});
