// dsh-plugin-yanyan-session-hub — Host (Node) half：会话管理中心的 HTTP 服务。
//
// 本插件是「会话管理中心」Phase 1 的独立开关，随聚合包发布。
// 数据层与 Host 服务/路由位于聚合包 lib/session-metadata*.js，本文件只做组装：
// ctx 能力 → SessionHubService → HTTP 路由，不重写任何存储/校验逻辑。
// 相对路径 ../../../lib/ 从 packages/<name>/lib/ 上溯到聚合包 lib/（三级，与 tgz 布局一致）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSessionHubService } from '../../../lib/session-metadata-service.js';
import { makeSessionHubRoutes } from '../../../lib/session-metadata-routes.js';

export const name = 'dsh-plugin-yanyan-session-hub';
// workspaceRegistry：原生归档 / 取消归档（archiveSession/unarchiveSession）的能力来源；
// 回收站融合后的 TrashService 也需要它做归档闸门。与 trash 子包同款 inject。
export const inject = ['webServer', 'connection', 'workspaceRegistry'];

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const VERSION = String(
  (JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8') || '{}').version) || '0.0.0',
);

export function apply(ctx) {
  const service = createSessionHubService(ctx);
  // 回收站融合：启动时收敛上一次崩溃残留的 purging 条目（幂等，失败不阻断路由注册）。
  // 复用 trash 子包原有的 recover-on-mount 纪律，避免融合后残留条目卡死。
  if (service.hasTrash && service.hasTrash()) {
    ctx.effect(() => {
      void service.trashRecover().catch(() => {
        // 条目保持 purging，可由 UI 的 recover 入口显式重试。
      });
    }, 'dsh-plugin-yanyan-session-hub: trash recover on mount');
  }
  for (const route of makeSessionHubRoutes(service, ctx)) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-plugin-yanyan-session-hub: route ' + route.path,
    );
  }
}
