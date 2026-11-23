// dsh-plugin-yanyan-toolkit — Host (Node) half.
//
// 聚合包的自身 loader 行只用于承载六项 patch 元数据与依赖声明，
// 五个功能插件各自有独立的 loader 行，由 DSH loader 直接挂载。
// 因此这里不重复官方全家桶的 dynamic shell（await import + ctx.plugin）
// 机制，只贡献两条同源回环路由：
//   1) /health     —— 确认本包已被装载；
//   2) /components —— 动态给出各组件自己的版本，供 client 半区在
//                     插件详情页「包含的组件」列表逐个显示。
//
// 版本一律从各组件自身的 package.json 读取，绝不写死，避免文档/DOM
// 与真实版本失同步（聚合包与五个功能插件可以各自独立发版）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-plugin-yanyan-toolkit';
export const inject = ['webServer', 'connection'];

export const HEALTH_ROUTE = '/__dsh-plugin-yanyan-toolkit/health';
export const COMPONENTS_ROUTE = '/__dsh-plugin-yanyan-toolkit/components';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SUBPACKAGES = [
  'dsh-plugin-yanyan-update',
  'dsh-plugin-yanyan-subagent',
  'dsh-plugin-yanyan-icon',
  'dsh-plugin-yanyan-session-hub',
  'dsh-find-right-plugin',
];

const FORBIDDEN_BODY = { ok: false, error: 'forbidden', message: '请求未通过 DSH 准入裁决。' };
const METHOD_BODY = { ok: false, error: 'method-not-allowed', message: '只接受 GET 或 POST 请求。' };

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

// 根包版本也从 package.json 动态读取，避免再出现 VERSION 常量与包声明失同步。
export const VERSION = String((readJsonSafe(join(ROOT_DIR, 'package.json')) || {}).version || '0.0.0');

/**
 * 收集聚合包内每个组件自己的版本：{ 包名: version }。
 * 自身 + 五个自写子包：读各自 package.json 的 version。
 * 第三方 @linxin666/dsh-session-archive 已于 1.4.13 彻底剔除，
 * 不再解析/回退它的版本。纯函数，rootDir 可注入以便单测，
 * 读不到一律给 'unknown' 而不抛错。
 */
export function collectVersions(rootDir = ROOT_DIR) {
  const out = {};
  const rootPkg = readJsonSafe(join(rootDir, 'package.json')) || {};
  out[rootPkg.name || 'dsh-plugin-yanyan-toolkit'] = String(rootPkg.version || 'unknown');

  for (const sub of SUBPACKAGES) {
    const pkg = readJsonSafe(join(rootDir, 'packages', sub, 'package.json')) || {};
    out[sub] = String(pkg.version || 'unknown');
  }
  return out;
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

// 统一准入：仅当 requestRejection 返回 undefined 时放行（不自建信任例外）。
function makeFence(ctx) {
  return (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined;
    } catch (error) {
      return false;
    }
  };
}

function makeRouteHandler(fence, payload) {
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
    try {
      respond(res, 200, payload());
    } catch (error) {
      respond(res, 200, { ok: false, error: 'internal', message: String((error && error.message) || error) });
    }
  };
}

// register 的返回值直接作为 effect 的清理函数，禁用 / HMR 时路由自动撤销。
// 复用 dsh-plugin-yanyan-update/lib/index.js:907-918 的多路由注册骨架。
export function apply(ctx) {
  const fence = makeFence(ctx);
  const routes = [
    {
      path: HEALTH_ROUTE,
      handler: makeRouteHandler(fence, () => ({ ok: true, name, version: VERSION })),
    },
    {
      path: COMPONENTS_ROUTE,
      handler: makeRouteHandler(fence, () => ({ ok: true, components: collectVersions() })),
    },
  ];
  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-plugin-yanyan-toolkit: route ' + route.path,
    );
  }
}
