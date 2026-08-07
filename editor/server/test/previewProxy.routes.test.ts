// =============================================================================
// previewProxy.routes.test.ts — 中継の HTTP 経路(迂回の本丸)
// =============================================================================
// 主張は「404 が返ること」ではなく「**上流へ 1 件もリクエストが届いていないこと**」である。
// 上流へ届けてから落とす実装は、応答時間差と上流のログで存在を漏らすうえ、Vite 側の
// ミドルウェア(`/@fs` や `/__open-in-editor`)が先に副作用を起こしうる。
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 上流(実 Vite の代役)が受け取った `req.url`。空のままなら 1 件も転送されていない。 */
const upstreamHits: string[] = [];
let upstreamPort = 0;
let docBase = '/vivliostyle';
let knownId = '';

vi.mock('../src/vivliostyle/previewServer.js', () => ({
  previewManager: {
    resolveFor: (id: string) => (id === knownId ? { port: upstreamPort, docBase } : undefined),
    touch: () => true,
    list: () => [],
    get: () => undefined,
    stop: async () => false,
    start: async () => {
      throw new Error('unused');
    },
  },
}));

describe('GET /api/preview/:id/* の中継許可リスト', () => {
  let app: FastifyInstance;
  let upstream: http.Server;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      upstreamHits.push(req.url ?? '');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<p>upstream</p>');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
    app = Fastify();
    app.setErrorHandler(errorHandler);
    // zip / octet-stream の Buffer 化は `vivliostyleRoutes` が自分の encapsulation 内で
    // 登録する(本番と同じ形)。非 GET がルートに登録されていないことをこの構成で確かめる。
    await app.register(vivliostyleRoutes, { prefix: '/api' });
    await app.ready();
    knownId = crypto.randomUUID();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  beforeEach(() => {
    upstreamHits.length = 0;
    docBase = '/vivliostyle';
  });

  const get = (suffix: string, id = knownId) =>
    app.inject({ method: 'GET', url: `/api/preview/${id}${suffix}` });

  it.each([
    '/@fs/C:/Users/caads/workspace/editor/server/tls/editor.pfx',
    '/@fs/C:/Users/caads/workspace/pnpm-workspace.yaml',
    '/@id/x',
    '/@vite/client',
    '/node_modules/evil.html',
    '/__open-in-editor?file=C:/x.js:1:1',
    '/vivliostyle-evil/x.html',
    '/%76ivliostyle/index.html',
    '/vivliostyle/%2e%2e/%2e%2e/@fs/C:/x',
    '/docs/index.html',
  ])('%s は 404 で、上流へ 1 件も届かない', async (suffix) => {
    const res = await get(suffix);
    expect(res.statusCode).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  it('未知のセッション id は 404(上流へ届かない)', async () => {
    const res = await get('/vivliostyle/index.html', crypto.randomUUID());
    expect(res.statusCode).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  it('UUID を percent-encoding で書いた id は受け付けない', async () => {
    // `params.id` は復号済みなので一致してしまうが、生 URL 側は長さが違う。literal UUID の
    // みを受けることで「検査した文字列と転送する文字列がずれる」形を型ごと排除する。
    const encoded = knownId.split('-').join('%2D');
    const res = await get('/vivliostyle/index.html', encoded);
    expect(res.statusCode).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  it('許可されたパスは転送され、上流が受け取る URL は検査した文字列と完全一致する', async () => {
    const res = await get('/__vivliostyle-viewer/index.html?src=x');
    expect(res.statusCode).toBe(200);
    expect(upstreamHits).toEqual(['/__vivliostyle-viewer/index.html?src=x']);
    expect(res.headers['content-security-policy']).toContain("'unsafe-eval'");
  });

  it('文書は docBase 配下だけが通り、CSP は script-src none になる', async () => {
    const res = await get('/vivliostyle/index.html');
    expect(res.statusCode).toBe(200);
    expect(upstreamHits).toEqual(['/vivliostyle/index.html']);
    expect(res.headers['content-security-policy']).toContain("script-src 'none'");
  });

  it('docBase が変われば通る集合も入れ替わる', async () => {
    docBase = '/docs';
    expect((await get('/docs/index.html')).statusCode).toBe(200);
    upstreamHits.length = 0;
    expect((await get('/vivliostyle/index.html')).statusCode).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  it.each([
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
  ])('%s はルートに登録されていない(ボディを積まずに 404)', async (method) => {
    const res = await app.inject({
      method: method as 'POST',
      url: `/api/preview/${knownId}/__vivliostyle-viewer/x`,
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.alloc(1024 * 1024),
    });
    expect(res.statusCode).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  it('HEAD も同じ許可リストを通る(自動生成される HEAD で迂回できない)', async () => {
    const denied = await app.inject({
      method: 'HEAD',
      url: `/api/preview/${knownId}/@fs/C:/x`,
    });
    expect(denied.statusCode).toBe(404);
    expect(upstreamHits).toEqual([]);
  });
});
