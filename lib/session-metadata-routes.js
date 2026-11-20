// dsh-plugin-yanyan-toolkit — 会话管理中心 · HTTP 路由层（Phase 1）。
//
// 复用回收站的通用 async handler 工厂 makeTrashHandler（fence → 方法校验 →
// body 解析 → fn → respond），不重复造轮子；本文件只负责：
//   1) 定义 /api/dsh-yanyan-session-hub/* 路由表；
//   2) 把 store 的验证异常收敛成统一 {ok:false,error,message} 错误体（fail-closed）。

import { makeTrashHandler } from './session-trash-routes.js';
import { METADATA_API_PREFIX } from './session-metadata-service.js';

export const METADATA_ROUTE_PREFIX = METADATA_API_PREFIX;
export const METADATA_ROUTE_PATHS = Object.freeze({
  list: `${METADATA_API_PREFIX}/list`,
  search: `${METADATA_API_PREFIX}/search`,
  indexStatus: `${METADATA_API_PREFIX}/index-status`,
  createFolder: `${METADATA_API_PREFIX}/folder/create`,
  renameFolder: `${METADATA_API_PREFIX}/folder/rename`,
  deleteFolder: `${METADATA_API_PREFIX}/folder/delete`,
  setFolder: `${METADATA_API_PREFIX}/session/folder`,
  addTag: `${METADATA_API_PREFIX}/session/tag/add`,
  removeTag: `${METADATA_API_PREFIX}/session/tag/remove`,
  setTitle: `${METADATA_API_PREFIX}/session/title`,
  export: `${METADATA_API_PREFIX}/export`,
  exportAll: `${METADATA_API_PREFIX}/export-all`,
  // 原生归档（融合后的核心能力：让会话真正从原生列表消失）。
  archive: `${METADATA_API_PREFIX}/archive`,
  unarchive: `${METADATA_API_PREFIX}/unarchive`,
  // 删除已归档会话（图9「删除」按钮）：解档 → 移入回收站 → 物理清除。
  deleteArchived: `${METADATA_API_PREFIX}/delete-archived`,
  // 统一删除（原生会话右键菜单「删除」）：后端按归档状态自行分流。
  deleteAny: `${METADATA_API_PREFIX}/delete-any`,
  // 回收站融合（trash 子包能力并入本子包，统一 prefix）。
  trashList: `${METADATA_API_PREFIX}/trash/list`,
  trashSnapshot: `${METADATA_API_PREFIX}/trash/snapshot`,
  trashRestore: `${METADATA_API_PREFIX}/trash/restore`,
  trashMove: `${METADATA_API_PREFIX}/trash/move`,
  trashPurge: `${METADATA_API_PREFIX}/trash/purge`,
  trashCascade: `${METADATA_API_PREFIX}/trash/cascade`,
  trashPurgeExpired: `${METADATA_API_PREFIX}/trash/purge-expired`,
  trashRecover: `${METADATA_API_PREFIX}/trash/recover`,
});

function makeFence(ctx) {
  return (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined;
    } catch {
      return false;
    }
  };
}

/**
 * 把抛错（参数校验失败等）收敛为统一错误体，保证路由永不 5xx、语义明确。
 * 必须是 async：store 写方法返回 Promise（withMetadataLock），同步 try/catch
 * 既抓不到 async reject，也会把 Promise 原样塞进响应对象被序列化成 {}。
 */
function safe(fn) {
  return async (body) => {
    try {
      return await fn(body);
    } catch (error) {
      return { ok: false, error: 'invalid', message: String((error && error.message) || error) };
    }
  };
}

/**
 * 解析 URL query 为对象（搜索路由用）。优先用 WHATWG URL，回退到手工切割。
 */
function parseQuery(req) {
  try {
    const raw = String(req.url || '');
    const qIdx = raw.indexOf('?');
    if (qIdx < 0) return {};
    const params = new URLSearchParams(raw.slice(qIdx + 1));
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * 构造全部会话中心路由。service / ctx 均可注入以便单测。
 * 返回 [{ path, method, handler }]，由子包 apply 统一注册为 ctx.webServer.register。
 */
export function makeSessionHubRoutes(service, ctx) {
  const fence = makeFence(ctx);
  const get = (path, fn) => ({ path, method: 'GET', handler: makeTrashHandler(fence, 'GET', safe(fn)) });
  const post = (path, fn) => ({ path, method: 'POST', handler: makeTrashHandler(fence, 'POST', safe(fn)) });
  return [
    get(METADATA_ROUTE_PATHS.list, async () => service.list()),
    // 搜索/索引状态：需要读 URL query，用带 req 的 handler。
    {
      path: METADATA_ROUTE_PATHS.search,
      method: 'GET',
      handler: (req, res) => {
        const query = parseQuery(req);
        return makeTrashHandler(fence, 'GET', safe(() => service.search(query.q || '', { limit: query.limit })))(req, res);
      },
    },
    get(METADATA_ROUTE_PATHS.indexStatus, async () => ({ ok: true, ...service.indexStatus() })),
    post(METADATA_ROUTE_PATHS.createFolder, async (b) => ({ ok: true, folder: await service.createFolder(b.name, { id: b.id }) })),
    post(METADATA_ROUTE_PATHS.renameFolder, async (b) => ({ ok: true, folder: await service.renameFolder(b.id, b.name) })),
    post(METADATA_ROUTE_PATHS.deleteFolder, async (b) => ({ ok: true, ...(await service.deleteFolder(b.id)) })),
    post(METADATA_ROUTE_PATHS.setFolder, async (b) => ({ ok: true, session: await service.setFolder(b.sessionId, b.folderId ?? null) })),
    post(METADATA_ROUTE_PATHS.addTag, async (b) => ({ ok: true, session: await service.addTag(b.sessionId, b.tag) })),
    post(METADATA_ROUTE_PATHS.removeTag, async (b) => ({ ok: true, session: await service.removeTag(b.sessionId, b.tag) })),
    post(METADATA_ROUTE_PATHS.setTitle, async (b) => ({ ok: true, session: await service.setTitle(b.sessionId, b.title) })),
    // Phase 3 批量导出：POST {ids:[...], filename?} → {ok,filename,base64,bytes,files,failed}
    post(METADATA_ROUTE_PATHS.export, async (b) => service.exportSessions(b.ids, { filename: b.filename })),
    post(METADATA_ROUTE_PATHS.exportAll, async (b) => service.exportAll({ filename: b.filename })),
    // 原生归档 / 取消归档（POST {ids:[...]} → {ok,done,failed}），失败逐条透传。
    post(METADATA_ROUTE_PATHS.archive, async (b) => service.archiveSessions(b.ids)),
    post(METADATA_ROUTE_PATHS.unarchive, async (b) => service.unarchiveSessions(b.ids)),
    post(METADATA_ROUTE_PATHS.deleteArchived, async (b) => service.deleteArchived(b.ids)),
    // 统一删除入口（右键菜单）：POST {ids:[...]} → {ok,done,failed,message}，后端按归档态分流。
    post(METADATA_ROUTE_PATHS.deleteAny, async (b) => service.deleteAny(b.ids)),
    // 回收站融合（统一 prefix，原样透传 TrashService 的 ok/primaryOk/descendantsOk/reason 语义）。
    get(METADATA_ROUTE_PATHS.trashList, async () => service.trashList()),
    get(METADATA_ROUTE_PATHS.trashSnapshot, async () => service.trashSnapshot()),
    post(METADATA_ROUTE_PATHS.trashRestore, async (b) => service.trashRestore(b.id)),
    post(METADATA_ROUTE_PATHS.trashMove, async (b) => service.trashMove(b.ids)),
    post(METADATA_ROUTE_PATHS.trashPurge, async (b) => service.trashPurge(b.ids)),
    post(METADATA_ROUTE_PATHS.trashCascade, async (b) => service.trashCascade(b.ids, b.protectedReason ?? {})),
    post(METADATA_ROUTE_PATHS.trashPurgeExpired, async () => service.trashPurgeExpired()),
    post(METADATA_ROUTE_PATHS.trashRecover, async () => service.trashRecover()),
  ];
}
