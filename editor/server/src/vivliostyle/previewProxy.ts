// =============================================================================
// previewProxy.ts — Express リクエストをループバック Vite プレビューサーバへ中継する
// =============================================================================
import http from 'node:http';
import type { Request, Response } from 'express';

/**
 * Express リクエストをループバックの Vite プレビューサーバへリバースプロキシする。
 *
 * プレビューサーバは HMR 無効で動くため通信は素の HTTP で、WebSocket の `upgrade`
 * 処理は不要。安全な(ボディなし)メソッドのみ転送する。プレビューは GET 駆動であり、
 * これにより共通の `express.json` ボディパーサが既にリクエストストリームを消費済みである
 * 問題も回避できる。
 */
export function proxyToPreview(
  host: string,
  port: number,
  forwardPath: string,
  req: Request,
  res: Response,
): void {
  const headers = { ...req.headers, host: `${host}:${port}` };
  const upstream = http.request(
    { host, port, method: req.method, path: forwardPath, headers },
    (up) => {
      res.status(up.statusCode ?? 502);
      for (const [key, value] of Object.entries(up.headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.status(502).json({ kind: 'network', message: 'プレビューサーバに接続できません' });
    } else {
      res.end();
    }
  });

  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}
