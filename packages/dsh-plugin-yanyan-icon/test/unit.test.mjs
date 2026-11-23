// 纯单测：只导入 lib/index.js 的纯函数与 apply，模块顶层不触发任何 DSH ctx 副作用。
// 用假 ctx / 假 res / 假 req 直接跑真实 handler，不联网、不依赖浏览器 DOM。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  name, VERSION, ROUTE_BASE, HEALTH_ROUTE, GENERATE_ROUTE,
  validateDataUrl, normalizeOptions, buildIconSvg, parseGenerateRequest, apply,
} from '../lib/index.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 一个合法但极小的 PNG base64（1×1 透明像素），仅用于数据形状校验。
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';
const WEBP = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAE';

test('元数据与路由常量', () => {
  assert.equal(name, 'dsh-plugin-yanyan-icon');
  assert.equal(ROUTE_BASE, '/__dsh-plugin-yanyan-icon');
  assert.equal(HEALTH_ROUTE, ROUTE_BASE + '/health');
  assert.equal(GENERATE_ROUTE, ROUTE_BASE + '/generate');
  assert.equal(VERSION, JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version);
});

test('validateDataUrl 只接受位图 base64 data URL', () => {
  assert.equal(validateDataUrl(PNG), true);
  assert.equal(validateDataUrl(JPEG), true);
  assert.equal(validateDataUrl(WEBP), true);
  assert.equal(validateDataUrl('data:image/svg+xml;base64,PHN2Zy8+'), false, 'SVG 必须拒绝');
  assert.equal(validateDataUrl('https://example.com/a.png'), false, '外链必须拒绝');
  assert.equal(validateDataUrl('javascript:alert(1)'), false);
  assert.equal(validateDataUrl('data:image/png;base64,not*base64'), false, '非法 base64 字符');
  assert.equal(validateDataUrl(null), false);
});

test('normalizeOptions 做整段覆盖与范围收敛', () => {
  assert.deepEqual(normalizeOptions({}), {
    background: '#eef2ff', border: '#c7d2fe', radius: 13, padding: 3, borderWidth: 1,
  });
  assert.deepEqual(normalizeOptions({ radius: 999, padding: -5, borderWidth: 9, background: '#123456' }), {
    background: '#123456', border: '#c7d2fe', radius: 28, padding: 0, borderWidth: 4,
  });
  // 非法颜色与注入字符串一律回退，绝不进 SVG 属性。
  assert.deepEqual(normalizeOptions({ background: 'red" onload="x', border: '#abc' }), {
    background: '#eef2ff', border: '#abc', radius: 13, padding: 3, borderWidth: 1,
  });
  assert.equal(normalizeOptions({ radius: '7' }).radius, 7);
});

test('buildIconSvg 生成自包含、无脚本、无外链、无 currentColor 的 SVG', () => {
  const svg = buildIconSvg(PNG, { background: '#101010', border: '#202020' });
  assert.ok(svg.startsWith('<svg '), '根元素');
  assert.ok(svg.includes('viewBox="0 0 64 64"'));
  assert.ok(svg.includes('width="64" height="64"'));
  assert.ok(svg.includes(PNG), '内嵌位图');
  assert.ok(svg.includes('xlink:href='));
  assert.ok(svg.includes('preserveAspectRatio="xMidYMid slice"'));
  assert.ok(svg.includes('clip-path="url(#yyicon-clip)"'));
  assert.ok(svg.includes('fill="#101010"'), '背景显式颜色');
  assert.ok(svg.includes('stroke="#202020"'), '边框显式颜色');
  // 安全约束：位图只出现一次（避免同一份 base64 写两遍把体积翻倍），且没有危险标记。
  assert.equal(svg.split(PNG).length - 1, 1);
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/foreignObject/i.test(svg));
  assert.ok(!/currentColor/.test(svg));
  assert.ok(!/https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '').replace('http://www.w3.org/1999/xlink', '')));
  assert.ok(Buffer.byteLength(svg, 'utf8') <= 32 * 1024, '不超过 32 KiB');
  assert.ok(svg.trimEnd().endsWith('</svg>'));
});

test('buildIconSvg 默认布局采用方案 A：位图占 52/64≈81%，30px 列表行不显小', () => {
  const svg = buildIconSvg(PNG);
  assert.ok(svg.includes('<rect x="3" y="3" width="58" height="58" rx="13"'), '外层圆角框 58');
  assert.ok(svg.includes('<rect x="6" y="6" width="52" height="52" rx="10"'), '裁切路径 52');
  assert.ok(svg.includes('<image x="6" y="6" width="52" height="52"'), '位图占 52/64');
  assert.ok(!svg.includes('width="44"'), '不再是旧的 44/64 偏小布局');
});

test('buildIconSvg 拒绝非法图片与超限产物', () => {
  assert.throws(() => buildIconSvg('data:image/svg+xml;base64,PHN2Zy8+'), /仅支持/);
  assert.throws(() => buildIconSvg('nope'), /仅支持/);
  // 构造一个超过 32 KiB 的合法 base64 载荷，验证硬上限。
  const big = 'data:image/png;base64,' + 'A'.repeat(34 * 1024);
  assert.throws(() => buildIconSvg(big), /32 KiB/);
});

test('parseGenerateRequest 解析并规范化，非法输入抛可读错误', () => {
  const parsed = parseGenerateRequest(JSON.stringify({ dataUrl: PNG, options: { radius: 6 } }));
  assert.equal(parsed.dataUrl, PNG);
  assert.equal(parsed.options.radius, 6);
  assert.equal(parsed.options.background, '#eef2ff');
  assert.throws(() => parseGenerateRequest('not-json'), /合法 JSON/);
  assert.throws(() => parseGenerateRequest(JSON.stringify({})), /dataUrl/);
  assert.throws(() => parseGenerateRequest(JSON.stringify({ dataUrl: 'javascript:x' })), /dataUrl/);
});

// ---- 路由：用假 ctx / 假 res / 假 req 跑真实 handler ----

function harness(rejection) {
  const routes = {};
  const ctx = {
    connection: { requestRejection: () => rejection },
    webServer: {
      register: (route) => {
        routes[route.path] = route.handler;
        return () => { delete routes[route.path]; };
      },
    },
    effect: (setup) => { setup(); },
  };
  return { ctx, routes };
}

function fakeRes() {
  return {
    status: 0, head: null, body: null,
    writeHead(status, head) { this.status = status; this.head = head; },
    end(payload) { this.body = JSON.parse(payload); },
  };
}

function fakeReq(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.destroy = () => {};
  // handler 同步挂上 data/end 监听后再投递数据。
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

test('apply 注册 health + generate 两条 exact 路由', () => {
  const { ctx, routes } = harness(undefined);
  apply(ctx);
  assert.deepEqual(Object.keys(routes).sort(), [GENERATE_ROUTE, HEALTH_ROUTE].sort());
});

test('health 返回本包版本与 no-store', () => {
  const { ctx, routes } = harness(undefined);
  apply(ctx);
  const res = fakeRes();
  routes[HEALTH_ROUTE]({ method: 'GET' }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, name, version: VERSION });
  assert.equal(res.head['cache-control'], 'no-store');
});

test('准入 fence 拒绝返回 403；health 方法非 GET/POST 返回 405', () => {
  const blocked = harness(new Error('denied'));
  apply(blocked.ctx);
  const r1 = fakeRes();
  blocked.routes[HEALTH_ROUTE]({ method: 'GET' }, r1);
  assert.equal(r1.status, 403);
  assert.equal(r1.body.error, 'forbidden');

  const open = harness(undefined);
  apply(open.ctx);
  const r2 = fakeRes();
  open.routes[HEALTH_ROUTE]({ method: 'DELETE' }, r2);
  assert.equal(r2.status, 405);
});

test('generate 路由：合法 POST 返回自包含 SVG', async () => {
  const { ctx, routes } = harness(undefined);
  apply(ctx);
  const res = fakeRes();
  const body = JSON.stringify({ dataUrl: PNG, options: { radius: 10 } });
  const done = new Promise((resolve) => {
    const orig = res.end.bind(res);
    res.end = (p) => { orig(p); resolve(); };
  });
  routes[GENERATE_ROUTE](fakeReq('POST', body), res);
  await done;
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.svg.startsWith('<svg '));
  assert.ok(res.body.svg.includes(PNG));
  assert.equal(res.body.size, Buffer.byteLength(res.body.svg, 'utf8'));
});

test('generate 路由：非法图片返回 400；GET 返回 405', async () => {
  const { ctx, routes } = harness(undefined);
  apply(ctx);

  const r1 = fakeRes();
  const done1 = new Promise((resolve) => {
    const orig = r1.end.bind(r1);
    r1.end = (p) => { orig(p); resolve(); };
  });
  routes[GENERATE_ROUTE](fakeReq('POST', JSON.stringify({ dataUrl: 'javascript:x' })), r1);
  await done1;
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, 'invalid-image');

  const r2 = fakeRes();
  routes[GENERATE_ROUTE]({ method: 'GET' }, r2);
  assert.equal(r2.status, 405);
});

test('client 半区源码具备稳定装载 / 裁切 / 预览 / 下载 / 清理契约', () => {
  const src = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8');
  for (const needle of [
    '__ModuleLoader__',
    "id: 'dsh-plugin-yanyan-icon'",
    "factory: ()",
    '/__dsh-plugin-yanyan-icon',
    'data-yanyan-icon-toolbar',
    'data-plugin-panel',
    'data-plugin-group="bundles"',
    'MutationObserver',
    'ctx.effect',
    'observer.disconnect()',
    'var inject = []',
    'drawCover',
    'toDataURL(\'image/png\')',
    "btoa(generatedSvg)",
    "'icon.svg'",
    'createObjectURL',
    'revokeObjectURL',
  ]) {
    assert.ok(src.includes(needle), `lib/client.js 缺少契约：${needle}`);
  }
  // 30px 行 / 36px 卡片双预览尺寸必须真实存在。
  assert.ok(src.includes('makePreview(T.rowLabel, 30)'));
  assert.ok(src.includes('makePreview(T.cardLabel, 36)'));
  // 点击预览放大查看（lightbox）契约。
  for (const needle of [
    'data-yyic-zoom',
    'yyic-lightbox',
    'data-yyic-lightbox-close',
    'function openLightbox',
    'function closeLightbox',
    "'data-yyic-zoom') !== null && t.src",
  ]) {
    assert.ok(src.includes(needle), `lib/client.js 缺少放大查看契约：${needle}`);
  }
  assert.ok(src.includes('closeLightbox();'), '清理 / reset / ESC 应关闭 lightbox');
});
