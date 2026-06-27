// =============================================================================
// previewProxy.ts — リクエストをループバック Vite プレビューサーバへ中継する
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';

/**
 * リクエストをループバックの Vite プレビューサーバへリバースプロキシする。
 *
 * 生の Node `http` の `req`/`res` を直接扱う。Fastify ルートからは `reply.hijack()` 済みの
 * `request.raw` / `reply.raw` を渡す(Fastify による応答送出を抑止し、ここで応答を完全所有する)。
 *
 * プレビューサーバは HMR 無効で動くため通信は素の HTTP で、WebSocket の `upgrade`
 * 処理は不要。安全な(ボディなし)メソッドのみ転送する。プレビューは GET 駆動であり、
 * これによりボディパーサが既にリクエストストリームを消費済みである問題も回避できる。
 */
export function proxyToPreview(
  host: string,
  port: number,
  forwardPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const headers = { ...req.headers, host: `${host}:${port}` };
  const upstream = http.request(
    { host, port, method: req.method, path: forwardPath, headers },
    (up) => {
      res.statusCode = up.statusCode ?? 502;
      for (const [key, value] of Object.entries(up.headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ kind: 'network', message: 'プレビューサーバに接続できません' }));
    } else {
      res.end();
    }
  });

  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}
