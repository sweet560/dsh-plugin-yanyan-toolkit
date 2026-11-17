// dsh-plugin-yanyan-toolkit — 回收站 HTTP 路由层（Host 半）。
//
// 职责：把 TrashService 的 list/restore/trash/purge/cascade/snapshot/recover
// 暴露为同源回环 HTTP 路由，供 React client 半区消费。本文件不含业务逻辑，
// 只做三件事：准入裁决（复用 toolkit 的 fence 纪律）、请求体解析、结果序列化。
//
// 设计纪律（沿用路径 A 与 toolkit 现有 lib/index.js）：
//   - 准入：ctx.connection.requestRejection(req)===undefined 才放行，
//     不自建任何信任例外（与 health/components 路由同一把尺）。
//   - 写操作走 POST、读操作走 GET（沿用现成包 mutating 需 POST 的纪律）。
//   - 所有 service 方法返回统一 {ok,...} 形状，路由原样序列化，不改写语义：
//     特别是 cascadePurge 的 ok/primaryOk/descendantsOk 与 reason 码必须原样透传，
//     4b UI 依赖这些字段做「影响范围」提示（整族保留 vs 单条目拒绝）。
//   - fail-closed：能力缺失/内部异常返回明确错误体，不静默成功。

import { TRASH_API_PREFIX } from './session-trash-service.js';

export const TRASH_ROUTE_PREFIX = TRASH_API_PREFIX;
export const TRASH_ROUTE_PATHS = Object.freeze({
  list: `${TRASH_API_PREFIX}/list`,
  snapshot: `${TRASH_API_PREFIX}/snapshot`,
  restore: `${TRASH_API_PREFIX}/restore`,
  trash: `${TRASH_API_PREFIX}/trash`,
  purge: `${TRASH_API_PREFIX}/purge`,
  cascade: `${TRASH_API_PREFIX}/cascade`,
  purgeExpired: `${TRASH_API_PREFIX}/purge-expired`,
  recover: `${TRASH_API_PREFIX}/recover`,
});

const FORBIDDEN_BODY = { ok: false, error: 'forbidden', message: '请求未通过 DSH 准入裁决。' };
const METHOD_BODY = { ok: false, error: 'method-not-allowed', message: '该路由不接受此 HTTP 方法。' };
const BAD_JSON_BODY = { ok: false, error: 'bad-json', message: '请求体不是合法 JSON 对象。' };
const TOO_LARGE_BODY = { ok: false, error: 'payload-too-large', message: '请求体过大。' };
const MAX_BODY_BYTES = 1_000_000;

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

/** 读取并解析 POST JSON body；返回带标记的错误对象而不是抛错。 */
function readBody(req) {
  return new Promise((resolve) => {
    try {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return resolve({ __tooLarge: true });
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return resolve({ __badJson: true });
          }
          resolve(parsed);
        } catch (error) {
          resolve({ __badJson: true });
        }
      });
      req.on('error', () => resolve({ __badJson: true }));
    } catch (error) {
      resolve({});
    }
  });
}

/** 构造 async 路由处理器：fence → 方法校验 → body 解析 → await fn(body) → respond。 */
function makeAsyncRouteHandler(fence, method, fn) {
  return async (req, res) => {
    if (!fence(req)) {
      respond(res, 403, FORBIDDEN_BODY);
      return;
    }
    const actual = String(req.method || 'GET').toUpperCase();
    if (actual !== method) {
      respond(res, 405, METHOD_BODY);
      return;
    }
    try {
      const body = method === 'POST' ? await readBody(req) : {};
      if (body.__tooLarge) {
        respond(res, 413, TOO_LARGE_BODY);
        return;
      }
      if (body.__badJson) {
        respond(res, 400, BAD_JSON_BODY);
        return;
      }
      const result = await fn(body);
      respond(res, 200, result);
    } catch (error) {
      respond(res, 200, { ok: false, error: 'internal', message: String((error && error.message) || error) });
    }
  };
}

/** 供测试直接构造单条路由处理器（校验 method/body 行为）。 */
export function makeTrashHandler(fence, method, fn) {
  return makeAsyncRouteHandler(fence, method, fn);
}

/**
 * 构造全部回收站路由。service 与 ctx 均可注入，便于单测。
 * 返回 [{ path, method, handler }]，由 apply 统一注册为 ctx.webServer.register。
 */
export function makeTrashRoutes(service, ctx) {
  const fence = makeFence(ctx);
  const get = (path, fn) => ({ path, method: 'GET', handler: makeAsyncRouteHandler(fence, 'GET', fn) });
  const post = (path, fn) => ({ path, method: 'POST', handler: makeAsyncRouteHandler(fence, 'POST', fn) });
  return [
    get(TRASH_ROUTE_PATHS.list, async () => service.list()),
    get(TRASH_ROUTE_PATHS.snapshot, async () => service.snapshot()),
    post(TRASH_ROUTE_PATHS.restore, async (body) => service.restore(body.id)),
    post(TRASH_ROUTE_PATHS.trash, async (body) => service.trash(body.ids)),
    post(TRASH_ROUTE_PATHS.purge, async (body) => service.purge(body.ids)),
    post(TRASH_ROUTE_PATHS.cascade, async (body) => service.cascadePurge(body.ids, body.protectedReason ?? {})),
    post(TRASH_ROUTE_PATHS.purgeExpired, async () => service.purgeExpired()),
    post(TRASH_ROUTE_PATHS.recover, async () => service.recoverPurging()),
  ];
}
