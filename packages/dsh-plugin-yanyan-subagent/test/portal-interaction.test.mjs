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

// ───────────────── bug1 回归：运行中行绝不被「清理全部空闲」选中 ─────────────────

test('manualCleanTargets：host 标注 running:true 的行也必须跳过（修复误删运行中）', () => {
  const { manualCleanTargets } = loadManualClean();
  const rows = [
    { id: 'idle-1', activity: 'inactive', running: false },
    { id: 'idle-2', kind: 'child' },                       // 无 activity、无 running → 空闲
    { id: 'running-host', activity: 'inactive', running: true },  // 官方行无 activity，靠 host 标注
    { id: 'running-legacy', activity: 'running' },         // 旧字段也要兼容
    { id: 'running-prefixed', childId: 'session-running-host', running: true },
  ];
  const out = manualCleanTargets(rows, { rootId: 'root' });
  assert.deepEqual(ids(out), ['idle-1', 'idle-2'], '运行中行（含 host 标注）必须全部排除');
});

test('isRowRunning：统一判定 host running 标注与旧 activity 字段', () => {
  const isRowRunning = vm.runInNewContext(
    extractFn(source, 'isRowRunning') + '\n;isRowRunning', {}, { filename: 'client-is-row-running.js' });
  assert.equal(isRowRunning(null), false);
  assert.equal(isRowRunning({ id: 'a' }), false, '无标注默认空闲');
  assert.equal(isRowRunning({ id: 'a', running: false }), false);
  assert.equal(isRowRunning({ id: 'a', running: true }), true, 'host 标注优先');
  assert.equal(isRowRunning({ id: 'a', activity: 'running' }), true, '兼容旧 activity 字段');
  assert.equal(isRowRunning({ id: 'a', activity: 'inactive', running: true }), true);
});

test('loadRows 叠加 host 实时运行状态：/running 路由被请求并打标', () => {
  const fn = extractFn(source, 'loadRows');
  assert.match(fn, /applyRunningState\(ctx, res\.rows\)/, 'loadRows 必须调用 applyRunningState 叠加状态');
  const apply = extractFn(source, 'applyRunningState');
  assert.match(apply, /ROUTE_BASE \+ '\/running'/, '应请求 /running 路由');
  assert.match(apply, /data\.runningIds/, '应消费 host 返回的 runningIds');
  assert.match(apply, /row\.running = true/, '命中运行中的行应打 running:true');
  assert.match(apply, /\.catch\(/, '请求失败要保守返回，不能抛错');
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

// ───────────────── UI 调整：浮层贴触发按钮 + 按钮对齐「创造模式」 ─────────────────

test('浮层定位：positionOverlay 按锚点按钮实时位置设置内联 left/top', () => {
  const fn = extractFn(source, 'positionOverlay');
  assert.match(fn, /getBoundingClientRect\(\)/, '应读取锚点按钮的实时位置');
  assert.match(fn, /overlayAnchor/, '应以 overlayAnchor 为锚点');
  assert.match(fn, /left = av\.left/, '水平应让浮层左边缘与按钮左边缘平齐、朝右展开');
  assert.ok(!/left = av\.right - cw/.test(fn), '不应再右边缘对齐、向左展开');
  assert.match(fn, /av\.bottom \+ ANCHOR_GAP/, '应优先放在按钮下方');
  assert.match(fn, /c\.style\.left/, '应设置内联 left');
  assert.match(fn, /c\.style\.top/, '应设置内联 top');
  // 旧实现写死右上角，必须消失。
  assert.ok(!/position:fixed;top:64px;right:24px/.test(source),
    'CSS 不应再写死 top:64px;right:24px');
});

test('浮层定位：打开前捕获触发按钮作为锚点（React + 原生降级两条路径）', () => {
  assert.match(source, /overlayAnchor = btnRef\.current/, 'React 路径应捕获 btnRef.current');
  assert.match(source, /ref: btnRef/, '按钮应挂 ref 才能拿到 DOM 元素');
  assert.match(source, /overlayAnchor = btn;/, '原生降级路径应捕获 btn');
  assert.match(source, /positionOverlay\(view\)/, '挂载后应调用 positionOverlay 定位');
});

test('浮层定位：视口 resize 时重定位所有已打开浮层', () => {
  assert.match(source, /addEventListener\('resize', positionAllViews\)/, '应注册 resize 重定位');
  assert.match(source, /removeEventListener\('resize', positionAllViews\)/, '应在 effect 清理时移除监听');
});

test('按钮样式：无边框 + 透明背景 + 宿主次级灰字，与「创造模式」一致', () => {
  const m = source.match(/\.yanyan-tab-btn\{[^}]*\}/);
  assert.ok(m, '应存在 .yanyan-tab-btn 规则');
  const rule = m[0];
  assert.match(rule, /background:transparent/, '背景应透明');
  assert.match(rule, /border:0(;|\})/, '应无边框');
  assert.match(rule, /--dsw-alias-label-secondary-foreground/, '应复用宿主次级灰字 token');
  assert.ok(!/border:1px solid/.test(rule), '不应再有边框');
});

// ───────────────── 点击空白关闭浮层 ─────────────────

// 在 vm 里用可控桩运行 closeOverlaysFromOutside，覆盖三种点击目标。
function loadOutsideCloser() {
  const code = extractFn(source, 'closeOverlaysFromOutside') + '\n'
    + '\n;({ closeOverlaysFromOutside })';
  // 用可变 state 对象承载，函数读取时通过 sandbox 全局注入。
  const sandbox = {
    views: [],
    nativeOverlay: null,
    overlayAnchor: null,
    closeEmitter: { emitted: 0, emit() { this.emitted += 1; } },
    closeNativeOverlay() { sandbox.nativeClosed += 1; },
    nativeClosed: 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client-outside-close.js' });
  return {
    sandbox,
    run(target, button) {
      vm.runInContext(
        'closeOverlaysFromOutside({ target: __target, button: __button })',
        Object.assign(sandbox, { __target: target, __button: button === undefined ? 0 : button }),
      );
    },
  };
}

// 构造一个 contains(target) 语义的容器桩。
function containerWith(child) {
  return {
    contains(t) { return t === child || t === this; },
    innerHTML: '',
  };
}

test('点击空白关闭：点浮层内部不关闭（含输入框等所有子元素）', () => {
  const h = loadOutsideCloser();
  const inner = { node: 'input' };
  h.sandbox.views.push({ container: containerWith(inner) });
  h.run(inner);
  assert.equal(h.sandbox.closeEmitter.emitted, 0, '浮层内点击不应触发关闭');
  assert.equal(h.sandbox.nativeClosed, 0);
});

test('点击空白关闭：点触发按钮本身不关闭（交给 toggle，避免先关后开）', () => {
  const h = loadOutsideCloser();
  const anchor = containerWith({});
  h.sandbox.overlayAnchor = anchor;
  // 没有任何浮层时函数会提前返回；放一个与本 target 无关的浮层。
  h.sandbox.views.push({ container: containerWith({ node: 'other' }) });
  h.run(anchor);
  assert.equal(h.sandbox.closeEmitter.emitted, 0, '点按钮不应由空白关闭逻辑处理');
  assert.equal(h.sandbox.nativeClosed, 0);
});

test('点击空白关闭：点浮层/按钮之外的空白区域会关闭（React + 原生两条路径都触发）', () => {
  const h = loadOutsideCloser();
  h.sandbox.views.push({ container: containerWith({ node: 'inside' }) });
  h.sandbox.nativeOverlay = {}; // 模拟有浮层存在
  const blank = { node: 'blank' };
  h.run(blank);
  assert.equal(h.sandbox.closeEmitter.emitted, 1, 'React 路径应 emit 关闭');
  assert.equal(h.sandbox.nativeClosed, 1, '原生降级路径应直接移除');
});

test('点击空白关闭：无浮层时点击空白不做任何事', () => {
  const h = loadOutsideCloser();
  h.run({ node: 'blank' });
  assert.equal(h.sandbox.closeEmitter.emitted, 0);
  assert.equal(h.sandbox.nativeClosed, 0);
});

test('点击空白关闭：右键（button!==0）不触发关闭', () => {
  const h = loadOutsideCloser();
  h.sandbox.views.push({ container: containerWith({ node: 'inside' }) });
  h.run({ node: 'blank' }, 2);
  assert.equal(h.sandbox.closeEmitter.emitted, 0, '右键不应关闭浮层');
});

test('点击空白关闭：事件在 document capture 阶段注册且清理时移除', () => {
  assert.match(source, /addEventListener\('mousedown', closeOverlaysFromOutside, true\)/,
    '应以 capture 阶段监听 mousedown');
  assert.match(source, /removeEventListener\('mousedown', closeOverlaysFromOutside, true\)/,
    '应在 effect 清理时移除监听');
});

// ───────────────── hover 弹出 / 移开消失 ─────────────────

test('hover：按钮 mouseenter 打开、mouseleave 延迟关闭（React + 原生两条路径）', () => {
  const actionBtn = extractFn(source, 'makeActionButton');
  // React 路径：按钮挂 onMouseEnter/onMouseLeave。
  assert.match(actionBtn, /onMouseEnter: onEnter/, '按钮应挂 onMouseEnter');
  assert.match(actionBtn, /onMouseLeave: onLeave/, '按钮应挂 onMouseLeave');
  assert.match(actionBtn, /cancelHoverClose\(\)/, '进入时应取消待执行的关闭');
  assert.match(actionBtn, /scheduleHoverClose\(\)/, '移开时应安排延迟关闭');
  assert.match(actionBtn, /if \(!open\) setOpen\(true\)/, 'hover 打开应只 setOpen(true) 不 toggle');
  // 原生降级路径：mouseenter/mouseleave 监听。
  const native = extractFn(source, 'injectNativeTabButton');
  assert.match(native, /addEventListener\('mouseenter'/, '原生按钮应监听 mouseenter');
  assert.match(native, /addEventListener\('mouseleave'/, '原生按钮应监听 mouseleave');
  assert.match(native, /ensureNativeOpen\(ctx, btn\)/, '原生 hover 打开应复用 ensureNativeOpen');
});

test('hover：浮层 mouseenter 取消关闭、mouseleave 重新计时（PortalHost + 原生 overlay）', () => {
  const portalFn = extractFn(source, 'PortalHost');
  assert.match(portalFn, /onMouseEnter: function \(\) \{ if \(props\.onEnter\) props\.onEnter\(\); \}/,
    'PortalHost 应把浮层 mouseenter 转给 onEnter 取消关闭');
  assert.match(portalFn, /onMouseLeave: function \(\) \{ if \(props\.onLeave\) props\.onLeave\(\); \}/,
    'PortalHost 应把浮层 mouseleave 转给 onLeave 重新计时');
  const nativeFn = extractFn(source, 'toggleOverlayNative');
  assert.match(nativeFn, /div\.addEventListener\('mouseenter', function \(\) \{ cancelHoverClose\(\); \}\)/,
    '原生浮层 mouseenter 应取消关闭');
  assert.match(nativeFn, /div\.addEventListener\('mouseleave', function \(\) \{ scheduleHoverClose\(\); \}\)/,
    '原生浮层 mouseleave 应重新计时');
});

test('hover：延迟关闭真实执行 schedule/cancel 语义（含定时器清理）', () => {
  const sandbox = {
    root: {
      setTimeout(fn, ms) { sandbox.lastDelay = ms; sandbox.pending = fn; return 1; },
      clearTimeout() { sandbox.cleared = true; },
    },
    HOVER_CLOSE_DELAY: 200,
    hoverCloseTimer: null,
    closeEmitter: { emitted: 0, emit() { this.emitted += 1; } },
    nativeClosed: 0,
    closeNativeOverlay() { sandbox.nativeClosed += 1; },
  };
  const code = extractFn(source, 'cancelHoverClose') + '\n'
    + extractFn(source, 'scheduleHoverClose') + '\n'
    + '\n;({ scheduleHoverClose, cancelHoverClose })';
  vm.createContext(sandbox);
  const api = vm.runInContext(code, sandbox, { filename: 'client-hover.js' });

  // schedule：设置延迟 200ms 的定时器。
  api.scheduleHoverClose();
  assert.equal(sandbox.lastDelay, 200, '应使用 HOVER_CLOSE_DELAY 延迟');
  assert.equal(typeof sandbox.pending, 'function', '应注册延迟关闭回调');

  // cancel：清除定时器。
  sandbox.cleared = false;
  api.cancelHoverClose();
  assert.equal(sandbox.cleared, true, 'cancel 应 clearTimeout');

  // 延迟回调真正触发时：emit 关闭 + 关闭原生浮层。
  api.scheduleHoverClose();
  sandbox.pending();
  assert.equal(sandbox.closeEmitter.emitted, 1, '延迟到点应 emit 关闭 React 浮层');
  assert.equal(sandbox.nativeClosed, 1, '延迟到点应关闭原生浮层');
});

// ───────────────── 模仿官方「N 个子智能体」浮层样式（图2） ─────────────────

test('按钮 hover：字变黑（随主题前景 token）、无边框、无背景，对齐官方按钮', () => {
  const m = source.match(/\.yanyan-tab-btn:hover[^{]*\{[^}]*\}/);
  assert.ok(m, '应存在 .yanyan-tab-btn:hover 规则');
  const rule = m[0];
  assert.match(rule, /background:transparent/, 'hover 时仍无背景');
  assert.match(rule, /border:0(;|\})/, 'hover 时仍无边框');
  assert.match(rule, /color:var\(--yanyan-fg,#1f2328\)/, 'hover 时用随主题前景（浅色黑/深色白）');
  assert.ok(!/--dsw-alias-label-primary-foreground/.test(rule),
    '不能用 --dsw-alias-label-primary-foreground（白字 token，会让字在浅色背景消失）');
});

test('图2 列表行：绿点 + 单行名称 + 状态徽标 + 删除 X 结构', () => {
  const fn = extractFn(source, 'renderRow');
  assert.match(fn, /yanyan-row-official/, '外层应用图2行样式类');
  assert.match(fn, /yanyan-row-dot/, '应有状态绿点');
  assert.match(fn, /data-dsh-part['"]?,\s*['"]row-dot/, '绿点应保留 part 标记');
  assert.match(fn, /yanyan-row-main/, '应有名称容器');
  assert.match(fn, /yanyan-row-name/, '应显示名称');
  // 用户要求删除第二行（id + token · 耗时）与纯装饰右箭头，行内只保留名称/状态/删除。
  assert.ok(!/yanyan-row-meta/.test(fn), '不应再渲染第二行 id + token · 耗时');
  assert.ok(!/rowTokenText\(row\)/.test(fn), '行内不应再探测 token 数');
  assert.ok(!/rowDurationText\(row\)/.test(fn), '行内不应再探测耗时');
  assert.ok(!/yanyan-row-arrow/.test(fn), '不应再渲染无交互的右箭头');
  assert.match(fn, /onRowDelete\(ctx, row\)/, '行内删除 X 回调必须保留');
  assert.match(fn, /yanyan-x/, '行内删除 X 按钮必须保留');
  assert.match(fn, /data-dsh-part['"]?,\s*['"]row['"]/, '外层 row part 标记必须保留');
});

test('bug2 状态标签：每行明确显示「空闲 / 运行中」文字徽标', () => {
  const fn = extractFn(source, 'renderRow');
  assert.match(fn, /isRowRunning\(row\)/, '运行状态应走统一判定');
  assert.match(fn, /t\('running'\)/, '运行中行应显示「运行中」标签');
  assert.match(fn, /t\('idle'\)/, '空闲行应显示「空闲」标签');
  assert.match(fn, /yanyan-status yanyan-running/, '运行中标签应用 yanyan-running 样式');
  assert.match(fn, /yanyan-status yanyan-idle/, '空闲标签应用 yanyan-idle 样式');
  assert.match(fn, /row-status-badge/, '状态徽标应带 data-dsh-part 便于定位');
  // 根会话 / 诊断行不应显示状态徽标。
  assert.match(fn, /row\.id !== shared\.rootId/, '根会话行不显示状态徽标');
  // 徽标宽度须贴合文字，不能被 column 父容器 stretch 成整行灰条。
  assert.match(source, /\.yanyan-status\{[^}]*align-self:flex-start/,
    '状态徽标应 align-self:flex-start，避免灰底铺满整行');
});

test('不向官方「N 个子智能体」面板注入单条删除 X（图1）', () => {
  const fn = extractFn(source, 'injectOfficialButtons');
  // 用户明确要求移除官方面板每行的 X：函数须为空操作，不再创建 X 按钮。
  assert.ok(!/createElement\(['"]button['"]\)/.test(fn), '不应再创建按钮');
  assert.ok(!/official-row-delete/.test(fn), '不应再注入 official-row-delete 标记');
  assert.ok(!/yanyan-official-x/.test(fn), '不应再注入官方面板 X 样式类');
  assert.ok(!/X_MARK/.test(fn), '不应再使用 X 字符');
});

test('图2 列表样式：绿点/名称 CSS 规则存在，meta 行与箭头样式已移除', () => {
  for (const cls of ['yanyan-row-official', 'yanyan-row-dot', 'yanyan-row-main',
    'yanyan-row-name']) {
    assert.ok(source.includes('.' + cls), `应存在 .${cls} 样式规则`);
  }
  assert.ok(!source.includes('.yanyan-row-meta'), '不应再保留 .yanyan-row-meta 样式规则');
  assert.ok(!source.includes('.yanyan-row-arrow'), '不应再保留 .yanyan-row-arrow 样式规则');
  assert.match(source, /\.yanyan-row-dot\{[^}]*background:#3fb950/, '空闲行应为绿点');
  assert.match(source, /\.yanyan-row-dot\.is-running\{[^}]*background:#2f6feb/, '运行行应为蓝点');
  // 模仿官方面板：悬停整行显示浅灰圆角背景高亮。
  assert.match(source, /\.yanyan-row-official:hover\{background:var\(--yanyan-idle-bg/,
    '行悬停应有浅灰圆角背景高亮');
  assert.match(source, /\.yanyan-row-official\{[^}]*border-radius:6px/,
    '行应有圆角以配合悬停高亮');
  // 用户反馈删到只剩一行时行下方留白：列表不应再设固定 min-height。
  assert.match(source, /\.yanyan-list\{[^}]*overflow:auto[^}]*\}/,
    '列表应保留 overflow:auto 滚动能力');
  assert.ok(!/\.yanyan-list\{[^}]*min-height/.test(source),
    '列表不应再设 min-height，否则单行时行下方留白');
});

// vm 真实执行 token / 耗时格式化（纯函数，无 DOM 依赖）。
function loadFormatters() {
  const code = extractFn(source, 'formatTokenCount') + '\n'
    + extractFn(source, 'formatDuration') + '\n'
    + '\n;({ formatTokenCount, formatDuration })';
  return vm.runInNewContext(code, {}, { filename: 'client-formatters.js' });
}

test('图2 指标格式化：token 数与耗时的真实执行', () => {
  const f = loadFormatters();
  assert.equal(f.formatTokenCount(21600), '21.6K tok', '大 token 数应转 K');
  assert.equal(f.formatTokenCount(500), '500 tok', '小 token 数原样');
  assert.equal(f.formatTokenCount(0), '', '无 token 数返回空');
  assert.equal(f.formatTokenCount(-1), '', '非法值返回空');
  assert.equal(f.formatDuration(500), '500ms', '小于 1 秒显示 ms');
  assert.equal(f.formatDuration(5000), '5秒', '秒级显示');
  assert.equal(f.formatDuration(65000), '1分5秒', '分钟级显示');
  assert.equal(f.formatDuration(60000), '1分', '整分钟无尾秒');
  assert.equal(f.formatDuration(-1), '', '非法值返回空');
});

// ───────────────── 无子智能体时隐藏「子智能体管理」按钮 ─────────────────

// vm 真实执行 hasSubagents：用可控桩提供 shared / isDeleted。
function loadHasSubagents() {
  const code = extractFn(source, 'hasSubagents') + '\n;({ hasSubagents })';
  const sandbox = {
    shared: { unsupported: false, rows: [], rootId: '' },
    deleted: [],
    isDeleted(id) { return sandbox.deleted.indexOf(id) !== -1; },
  };
  vm.createContext(sandbox);
  const api = vm.runInContext(code, sandbox, { filename: 'client-visibility.js' });
  return { sandbox, api };
}

test('按钮显隐：hasSubagents 真实执行（空/诊断/已删除/root 均不算子智能体）', () => {
  const { sandbox, api } = loadHasSubagents();
  // 空列表 → 隐藏
  assert.equal(api.hasSubagents(), false, '无行应判定为无子智能体');
  // 普通行 → 显示
  sandbox.shared.rows = [{ id: 'sub-1' }];
  assert.equal(api.hasSubagents(), true, '有普通子智能体行应显示');
  // 只有诊断行 → 隐藏
  sandbox.shared.rows = [{ id: 'diag', kind: 'diagnostic' }];
  assert.equal(api.hasSubagents(), false, '诊断行不算子智能体');
  // 只有已删除行 → 隐藏
  sandbox.shared.rows = [{ id: 'gone' }];
  sandbox.deleted = ['gone'];
  assert.equal(api.hasSubagents(), false, '已删除行不算子智能体');
  // 只有根会话行 → 隐藏
  sandbox.deleted = [];
  sandbox.shared.rootId = 'root';
  sandbox.shared.rows = [{ id: 'root' }];
  assert.equal(api.hasSubagents(), false, '根会话行不算子智能体');
  // 数据源不支持 → 保守显示，避免探测失败把入口永久藏掉
  sandbox.shared.rows = [];
  sandbox.shared.unsupported = true;
  assert.equal(api.hasSubagents(), true, 'unsupported 时应保守显示');
});

test('按钮显隐：refresh 数据到位后推送显隐判定', () => {
  assert.match(source, /var visibilityEmitter = makeEmitter\(\)/, '应声明 visibilityEmitter');
  const refresh = extractFn(source, 'refresh');
  assert.match(refresh, /visibilityEmitter\.emit\(hasSubagents\(\)\)/,
    'refresh 更新 rows 后应推送显隐状态');
});

test('按钮显隐：React 路径按钮随状态渲染，隐藏时关闭浮层', () => {
  const fn = extractFn(source, 'makeActionButton');
  assert.match(fn, /visibilityEmitter\.subscribe/, 'React 路径应订阅 visibilityEmitter');
  assert.match(fn, /visible \? React\.createElement\('button'/, '隐藏时按钮应不渲染');
  assert.match(fn, /if \(!v\) setOpen\(false\)/, '子智能体消失时应一并关闭浮层');
});

test('按钮显隐：原生降级路径 btn 随状态显隐', () => {
  const fn = extractFn(source, 'injectNativeTabButton');
  assert.match(fn, /btn\.style\.display = 'none'/, '初始应先隐藏，避免闪烁');
  assert.match(fn, /visibilityEmitter\.subscribe/, '原生路径应订阅 visibilityEmitter');
  assert.match(fn, /btn\.style\.display = v \? '' : 'none'/, '应按显隐状态切换 display');
});

test('刷新按钮：点击后给出「正在刷新…→已刷新」可见反馈（用户反馈「点击刷新没反应」）', () => {
  // 字典键必须存在且中英对照（否则 t() 会拿到 undefined）。
  assert.match(source, /refreshing:\s*'正在刷新…'/, 'zh 字典应有 refreshing');
  assert.match(source, /refreshed:\s*'已刷新'/, 'zh 字典应有 refreshed');
  assert.match(source, /refreshing:\s*'Refreshing\.\.\.'/, 'en 字典应有 refreshing');
  assert.match(source, /refreshed:\s*'Refreshed'/, 'en 字典应有 refreshed');
  // 刷新按钮回调：立即显示「正在刷新…」，refresh 完成后显示「已刷新」，失败显示「失败」。
  const refreshBtn = source.slice(source.indexOf("'refresh', function ()"), source.indexOf("'settings-toggle'"));
  assert.match(refreshBtn, /t\('refreshing'\)/, '点击刷新应立即显示「正在刷新…」');
  assert.match(refreshBtn, /refresh\(ctx\)/, '刷新按钮应调用 refresh(ctx)');
  assert.match(refreshBtn, /t\('refreshed'\)/, '刷新成功应显示「已刷新」');
  assert.match(refreshBtn, /t\('failed'\)/, '刷新失败应显示「失败」');
  assert.match(refreshBtn, /view\.update\(\)/, '状态变化后应重绘浮层');
});

// ───────────────── 定时自动清理真实触发（功能性 BUG 修复）─────────────────
// 用户反馈「自动删除功能会真实触发吗？」——根因：idleFilterLocal 强制要求
// activity==='inactive'，而官方 catalog 行根本没有 activity 字段，导致定时
// 自动清理永远筛不到目标；updateIdleTracking 也只认 activity==='inactive'，
// 使 firstSeen 从不记录、idleSince 回退成 Date.now()，阈值同样永不满足。

test('idleFilterLocal：无 activity 的官方空闲行也能被自动清理选中（自动删除真实触发）', () => {
  const code = extractFn(source, 'idleFilterLocal') + '\n;({ idleFilterLocal })';
  const { idleFilterLocal } = vm.runInNewContext(code, {}, { filename: 'client-idle-filter.js' });
  const rows = [
    { id: 'idle-official', kind: 'child' },                 // 官方行：无 activity → 应选中
    { id: 'idle-legacy', activity: 'inactive' },            // 旧行：应选中
    { id: 'running-host', running: true },                  // host 标 running → 排除
    { id: 'running-legacy', activity: 'running' },          // 旧 running → 排除
    { id: 'diag', activity: 'inactive', kind: 'diagnostic' }, // 诊断 → 排除
    { id: 'root', activity: 'inactive' },                   // 根会话 → 排除
  ];
  const out = idleFilterLocal(rows, {
    rootId: 'root',
    idleMinutes: 30,
    now: 2000000,
    idleSince: function () { return 0; },                   // 很久以前 → 满足阈值
  });
  assert.deepEqual(ids(out), ['idle-official', 'idle-legacy']);
  // 源码层面确认不再强制 activity==='inactive'（这是「自动删除不触发」的根因）。
  assert.ok(!/row\.activity !== 'inactive'/.test(extractFn(source, 'idleFilterLocal')),
    '自动清理不应再强制要求 activity===inactive');
});

test('updateIdleTracking：用统一运行中判定记录官方行的空闲起点', () => {
  const fn = extractFn(source, 'updateIdleTracking');
  assert.match(fn, /isRowRunning\(r\)/, '应使用统一运行中判定决定是否重置 firstSeen');
  assert.ok(!/r\.activity === 'inactive'/.test(fn),
    '不应只认 activity===inactive，否则官方行从不记录空闲起点、阈值永不满足');
});

// ───────────────── 自动清理覆盖多会话 + 空闲起点持久化（用户实测缺陷） ─────────────────
// 缺陷：巡检只看当前主视图会话，切会话后原会话的空闲子智能体永远巡检不到；
// 且 firstSeen 是内存 Map，重启清零 → 空闲时长反复从零重算、阈值永不满足。

test('deriveAllRootIds：枚举所有含 subagentCatalog 投影的会话，主视图排最前', () => {
  const fn = extractFn(source, 'deriveAllRootIds');
  const { deriveAllRootIds } = vm.runInNewContext(fn + '\n;({ deriveAllRootIds })', {}, { filename: 'client-all-roots.js' });
  const ctx = {
    sessions: { list: { getSnapshot() {
      return {
        byId: {
          s1: { id: 's1', retainedBy: { mainView: 1 } }, // 主视图
          s2: { id: 's2', retainedBy: { mainView: 0 } },
        },
        projectionsBySession: {
          s1: { values: { subagentCatalog: [] } },
          s2: { values: { subagentCatalog: [] } },
          s3: { values: { subagentCatalog: [] } },
          s4: { values: {} }, // 无 subagentCatalog → 应排除
        },
      };
    } } },
  };
  const out = deriveAllRootIds(ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), ['s1', 's2', 's3'],
    '主视图 s1 排最前，其余含 catalog 的会话依次纳入，无 catalog 的 s4 排除');
});

test('loadFirstSeen：从 localStorage 恢复空闲起点，coreId 归一化并丢弃非法/陈旧记录', () => {
  const now = Date.now();
  const saved = {
    'session-aaa': now - 1000,                     // 合法，带 session- 前缀
    bbb: now - 2000,                               // 合法
    ccc: 'not-a-number',                           // 非法时间戳 → 丢弃
    stale: now - 31 * 24 * 60 * 60 * 1000,         // 超 30 天 → 丢弃
  };
  const code = extractFn(source, 'coreId') + '\n'
    + extractFn(source, 'loadFirstSeen') + '\n'
    + '\n;({ loadFirstSeen })';
  const sandbox = {
    LS_FIRST_SEEN: 'yanyan-subagent.firstSeen',
    readLS: (k) => (k === 'yanyan-subagent.firstSeen' ? JSON.stringify(saved) : null),
  };
  const { loadFirstSeen } = vm.runInNewContext(code, sandbox, { filename: 'client-first-seen.js' });
  const map = loadFirstSeen();
  assert.equal(map.get('aaa'), now - 1000, 'session- 前缀应归一化为 aaa');
  assert.equal(map.get('bbb'), now - 2000);
  assert.equal(map.has('ccc'), false, '非法时间戳应丢弃');
  assert.equal(map.has('stale'), false, '超 30 天陈旧记录应丢弃');
});

test('空闲起点持久化：shared 用 loadFirstSeen 初始化，updateIdleTracking 变更后写回', () => {
  const src = source;
  assert.match(src, /firstSeen:\s*loadFirstSeen\(\)/, 'shared.firstSeen 应从 localStorage 恢复');
  const track = extractFn(src, 'updateIdleTracking');
  assert.match(track, /coreId\(r\.id\)/, 'key 应 coreId 归一化，兼容 session- 前缀');
  assert.match(track, /persistFirstSeen\(\)/, '空闲起点变更应写回 localStorage');
  assert.ok(!/splice\(|firstSeen\.forEach\(/.test(track),
    '逐会话巡检时不应基于单批 rows 做消失清理，否则误删其他会话的起点');
});

test('loadRows：支持 overrideRootId，巡检按会话读取 catalog', () => {
  const fn = extractFn(source, 'loadRows');
  assert.match(fn, /function loadRows\(ctx, overrideRootId\)/, '应支持覆盖 rootId');
  assert.match(fn, /overrideRootId \|\| deriveRootId\(ctx\)/, '未覆盖时才回落当前主视图会话');
});

test('autoCleanTick：遍历所有会话巡检，删除时传入所属会话 rootId，不污染当前视图', () => {
  const fn = extractFn(source, 'autoCleanTick');
  assert.match(fn, /deriveAllRootIds\(ctx\)/, '应枚举所有含 subagentCatalog 的会话');
  assert.match(fn, /rootIds\.forEach/, '应逐会话巡检');
  assert.match(fn, /loadRows\(ctx, rid\)/, '应按会话覆盖 catalog 数据');
  assert.match(fn, /deleteOne\(ctx, r, false, res\.rootId\)/, '删除时应传该行所属会话 rootId');
  assert.match(fn, /refreshSidebar\(ctx, res\.rootId\)/, '应按会话刷新侧边栏');
  assert.match(fn, /idleFilterLocal\(/, '仍应用空闲过滤');
  assert.match(fn, /idleMinutes:/, '仍应用阈值契约');
  assert.ok(!/shared\.rows\s*=/.test(fn), '后台巡检不应污染当前视图 rows');
});
