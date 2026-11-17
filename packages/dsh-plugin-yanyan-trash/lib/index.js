// dsh-plugin-yanyan-trash — Host (Node) half：回收站的 HTTP 服务。
//
// 本插件是「会话回收站」的独立开关，随聚合包 dsh-plugin-yanyan-toolkit 一起发布。
// 物理删除/归档/快照/级联的四个纯函数模块位于聚合包 lib/ 下（路径 A 第 1~4a 阶段），
// 本文件只做组装：ctx 能力 → TrashService → HTTP 路由，不重写任何安全逻辑。
// 相对路径 ../../../lib/ 从 packages/dsh-plugin-yanyan-trash/lib/ 上溯到聚合包 lib/，
// 源码布局与 tgz 内布局（package/lib/ 与 package/packages/<name>/lib/）一致，均为三级。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTrashService } from '../../../lib/session-trash-service.js';
import { makeTrashRoutes } from '../../../lib/session-trash-routes.js';

export const name = 'dsh-plugin-yanyan-trash';
export const inject = ['webServer', 'connection', 'workspaceRegistry'];

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const VERSION = String(
  (JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8') || '{}').version) || '0.0.0',
);

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

export function apply(ctx) {
  const service = createTrashService(ctx);
  // 启动时收敛上一次崩溃残留的 purging 条目（幂等，失败不阻断路由注册）。
  ctx.effect(() => {
    void service.recoverPurging().catch(() => {
      // 条目保持 purging，可由 UI 的 recover 入口显式重试。
    });
  }, 'dsh-plugin-yanyan-trash: recover on mount');

  for (const route of makeTrashRoutes(service, ctx)) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-plugin-yanyan-trash: route ' + route.path,
    );
  }
}
