// dsh-plugin-yanyan-icon — Host 半区。
//
// 职责：把浏览器半区预处理好的正方形 PNG / JPEG / WebP base64 图片，包装成
// 适配 DSH 插件列表图标位（<img> 加载、行 30px / 卡片 36px 显示）的自包含静态 SVG。
//
// 形态照抄 dsh-plugin-yanyan-update/lib/index.js 的 respond / readBody / apply /
// ctx.effect + ctx.webServer.register 骨架；准入一律走 ctx.connection.requestRejection。
//
// 约束：纯 JavaScript ESM，模块顶层不得访问 document / window / ctx；apply 只在被调用时
// 才注册路由。buildIconSvg / normalizeOptions / validateDataUrl / parseGenerateRequest
// 都是纯函数，无 DSH 依赖，单测可直接导入。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-plugin-yanyan-icon';
export const inject = ['webServer', 'connection'];
export const ROUTE_BASE = '/__dsh-plugin-yanyan-icon';
export const HEALTH_ROUTE = ROUTE_BASE + '/health';
export const GENERATE_ROUTE = ROUTE_BASE + '/generate';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

// 版本一律从自身 package.json 动态读取，避免硬编码常量与包声明失同步。
export const VERSION = String((readJsonSafe(join(PKG_DIR, 'package.json')) || {}).version || '0.0.0');

const BODY_LIMIT = 2 * 1024 * 1024;
// DSH 市场索引对内联 data: 图标的硬上限（dsh-plugin-market-index 的
// MAX_INLINE_ICON_BYTES = 32 * 1024）。本地 icon.svg 不强制，但对齐该上限可保证
// 生成物在任何装载路径下都不会被拒，且 30/36px 显示也不需要更大的文件。
const MAX_OUTPUT_BYTES = 32 * 1024;

const FORBIDDEN_BODY = {
  ok: false,
  error: 'forbidden',
  message: '请求未通过 DSH 准入裁决。',
};
const METHOD_BODY = {
  ok: false,
  error: 'method-not-allowed',
  message: '只接受 GET 或 POST 请求。',
};

// 只允许位图 base64 data URL；SVG / javascript: / 外链一律拒绝，避免把脚本或外部引用
// 带进会被 <img> 渲染的图标里。正则与 dsh-plugin-market-index 的 DATA_ICON 同源。
const DATA_ICON = /^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;

export function validateDataUrl(value) {
  return typeof value === 'string' && DATA_ICON.test(value);
}

// 颜色只接受 #rgb / #rrggbb，杜绝把引号或标签注入到 SVG 属性里。
function safeColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)
    ? value
    : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 整段覆盖、不深合并：只认列出的键，逐个做类型与范围规范化。纯函数，可单测。
export function normalizeOptions(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    background: safeColor(c.background, '#eef2ff'),
    border: safeColor(c.border, '#c7d2fe'),
    radius: clampInt(c.radius, 0, 28, 13),
    padding: clampInt(c.padding, 0, 16, 3),
    borderWidth: clampInt(c.borderWidth, 0, 4, 1),
  };
}

// 核心纯函数：生成 64×64 viewBox、圆角矩形背景、居中内嵌位图的自包含静态 SVG。
// 无 script、无 foreignObject、无外链、无 currentColor（<img> 上下文不继承页面色，
// 所有颜色都给显式值），内嵌图片经 clipPath 裁成圆角，四周留出 padding 呼吸空间。
// 默认布局（方案 A）：outer=3 / frameSize=58 / padding=3 / radius=13，位图占 52/64≈81%，
// 在 DSH 列表行 30px 下比旧的 44/64≈69% 明显更大，同时保留圆角框呼吸感。
// 只写 xlink:href 一个 href，避免同一份 base64 在文件里出现两次把体积翻倍。
export function buildIconSvg(dataUrl, rawOptions) {
  if (!validateDataUrl(dataUrl)) {
    throw new Error('仅支持 PNG / JPEG / WebP 的 base64 图片数据。');
  }
  const o = normalizeOptions(rawOptions);
  const outer = 3;
  const frameSize = 58;
  const inner = frameSize - o.padding * 2;
  const ix = outer + o.padding;
  const innerRadius = Math.max(0, o.radius - o.padding);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="plugin icon">',
    '<defs><clipPath id="yyicon-clip"><rect x="' + ix + '" y="' + ix + '" width="' + inner + '" height="' + inner + '" rx="' + innerRadius + '"/></clipPath></defs>',
    '<rect x="' + outer + '" y="' + outer + '" width="' + frameSize + '" height="' + frameSize + '" rx="' + o.radius + '" fill="' + o.background + '" stroke="' + o.border + '" stroke-width="' + o.borderWidth + '"/>',
    '<image x="' + ix + '" y="' + ix + '" width="' + inner + '" height="' + inner + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#yyicon-clip)" xlink:href="' + dataUrl + '"/>',
    '</svg>',
  ].join('\n');
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new Error('生成图标超过 32 KiB 上限，请换一张更小的图片。');
  }
  return svg;
}

// 从请求体字符串解析出生成参数；非法 JSON / 缺字段 / 非法图片统一抛可读错误。
// 纯函数，单测可直接调用，不需要 DSH 运行时。
export function parseGenerateRequest(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    throw new Error('请求体不是合法 JSON。');
  }
  if (!body || typeof body !== 'object' || !validateDataUrl(body.dataUrl)) {
    throw new Error('缺少合法的 dataUrl 图片数据。');
  }
  return { dataUrl: body.dataUrl, options: normalizeOptions(body.options) };
}

function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function makeFence(ctx) {
  return (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined;
    } catch (error) {
      return false;
    }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体超过 2 MiB 上限。'));
        try { req.destroy(); } catch (error) {}
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function makeHealthHandler(fence) {
  return (req, res) => {
    if (!fence(req)) {
      respond(res, 403, FORBIDDEN_BODY);
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      respond(res, 405, METHOD_BODY);
      return;
    }
    respond(res, 200, { ok: true, name, version: VERSION });
  };
}

function makeGenerateHandler(fence) {
  return (req, res) => {
    if (!fence(req)) {
      respond(res, 403, FORBIDDEN_BODY);
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      respond(res, 405, METHOD_BODY);
      return;
    }
    readBody(req).then((raw) => {
      let parsed;
      try {
        parsed = parseGenerateRequest(raw);
      } catch (error) {
        respond(res, 400, { ok: false, error: 'invalid-image', message: String((error && error.message) || error) });
        return;
      }
      try {
        const svg = buildIconSvg(parsed.dataUrl, parsed.options);
        respond(res, 200, {
          ok: true,
          svg,
          size: Buffer.byteLength(svg, 'utf8'),
          hint: '把下载的 icon.svg 放到插件包根目录，并在 package.json 声明 icon 与 exports["./icon"]。',
        });
      } catch (error) {
        respond(res, 400, { ok: false, error: 'invalid-image', message: String((error && error.message) || error) });
      }
    }).catch((error) => {
      respond(res, 400, { ok: false, error: 'bad-request', message: String((error && error.message) || error) });
    });
  };
}

// register 的返回值直接作为 effect 的清理函数，禁用 / HMR 时路由自动撤销。
export function apply(ctx) {
  const fence = makeFence(ctx);
  const routes = [
    { path: HEALTH_ROUTE, handler: makeHealthHandler(fence) },
    { path: GENERATE_ROUTE, handler: makeGenerateHandler(fence) },
  ];
  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-plugin-yanyan-icon: route ' + route.path,
    );
  }
  try {
    ctx.logger?.info?.('[dsh-plugin-yanyan-icon] host routes ready');
  } catch (error) {
    // 日志服务不可用时不影响路由注册
  }
}
