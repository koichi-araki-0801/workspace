import http from 'node:http';
import type { Request, Response } from 'express';

/**
 * Reverse-proxy an Express request to the loopback Vite preview server.
 *
 * The preview server runs with HMR disabled, so traffic is plain HTTP and no
 * WebSocket `upgrade` handling is needed. Only safe (bodyless) methods are
 * forwarded — preview is GET-driven — which also sidesteps the global
 * `express.json` body parser having already consumed the request stream.
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
