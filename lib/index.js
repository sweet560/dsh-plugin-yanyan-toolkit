// dsh-plugin-yanyan-toolkit — Host (Node) half.
//
// 聚合包的自身 loader 行只用于承载四项 patch 元数据与依赖声明，
// 三个功能插件各自有独立的 loader 行，由 DSH loader 直接挂载。
// 因此这里不重复官方全家桶的 dynamic shell（await import + ctx.plugin）
// 机制，只贡献一条同源回环健康检查路由，便于确认本包已被装载。

export const name = 'dsh-plugin-yanyan-toolkit';
export const VERSION = '1.0.0';
export const inject = ['webServer', 'connection'];

export const HEALTH_ROUTE = '/__dsh-plugin-yanyan-toolkit/health';

function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function healthHandler(ctx) {
  return (req, res) => {
    const fence = () => ctx.connection.requestRejection(req) === undefined;
    if (!fence()) {
      respond(res, 403, { ok: false, error: 'forbidden', message: '请求未通过 DSH 准入裁决。' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      respond(res, 405, { ok: false, error: 'method-not-allowed', message: '只接受 GET 或 POST 请求。' });
      return;
    }
    respond(res, 200, { ok: true, name, version: VERSION });
  };
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: HEALTH_ROUTE, handler: healthHandler(ctx) }),
    'dsh-plugin-yanyan-toolkit: health route',
  );
}
