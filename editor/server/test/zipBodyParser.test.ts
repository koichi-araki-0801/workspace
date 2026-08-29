// =============================================================================
// zipBodyParser.test.ts — zip 本文パーサの適用範囲
// =============================================================================
// 関数形式の content-type parser は Fastify の `rawBody` を経由しないので `bodyLimit` が
// **一切効かない**。それをルートインスタンスへ登録すると、encapsulation の伝播と
// 相まって「任意の POST/PUT に `Content-Type: application/zip` を付ければ `maxProjectBytes`
// (既定 64MB)を積める」状態になる。パーサは preHandler より先に走るのでロールガードは
// 1 バイトも防げない。
//
// 主張するのは「**適用範囲が閉じていること**」と「**上限が効くこと**」:
//   ① 許可リスト(zip を受ける 2 ルートの登録パターン)以外は 1 バイトも読まずに 400。
//   ② パーサは `vivliostyleRoutes` の外側(= 他 plugin のルート)へ伝播しない。
//   ③ 申告値だけでなく**実際に読んだバイト数**で `maxProjectBytes` を強制する。
import { describe, expect, it } from 'vitest';
import { isZipBodyRoute, zipBodyRoutesFor } from '../src/routes/zipBodyParser.js';

describe('許可リスト', () => {
  const allowed = zipBodyRoutesFor('/api');

  it('zip を受ける 2 ルートだけを許す', () => {
    expect([...allowed].sort()).toEqual(['/api/build/project', '/api/preview']);
    expect(isZipBodyRoute(allowed, '/api/build/project')).toBe(true);
    expect(isZipBodyRoute(allowed, '/api/preview')).toBe(true);
  });

  it('inline build や他ルートは受け付けない', () => {
    expect(isZipBodyRoute(allowed, '/api/build')).toBe(false);
    expect(isZipBodyRoute(allowed, '/api/build/merge')).toBe(false);
    expect(isZipBodyRoute(allowed, '/api/templates/:templateId/draft')).toBe(false);
    expect(isZipBodyRoute(allowed, '/api/review-requests')).toBe(false);
  });

  it('登録パターン以外(生 URL の綴り差・非文字列)は通さない', () => {
    // 生の request target で照合すると percent-encoding で判定を外せてしまう。
    // ここへ渡すのは常に `request.routeOptions.url`(復号済みの登録パターン)である。
    expect(isZipBodyRoute(allowed, '/api/build/%70roject')).toBe(false);
    expect(isZipBodyRoute(allowed, undefined)).toBe(false);
    expect(isZipBodyRoute(allowed, {})).toBe(false);
  });

  it('クエリ・フラグメントは落としてから比較する', () => {
    expect(isZipBodyRoute(allowed, '/api/build/project?entry=a.html')).toBe(true);
  });

  it('prefix は登録時のものに追従する(`/api` を焼き付けない)', () => {
    expect([...zipBodyRoutesFor('')].sort()).toEqual(['/build/project', '/preview']);
  });
});

describe('encapsulation', () => {
  it('vivliostyleRoutes の外側のルートには zip パーサが伝播しない', async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(vivliostyleRoutes, { prefix: '/api' });
    // 別 plugin(= 別 encapsulation)のルート。zip パーサはここへ来てはならない。
    await app.register(
      async (i) => {
        i.post('/echo', async () => ({ ok: true }));
      },
      { prefix: '/other' },
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/other/echo',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from('PK'),
    });
    // パーサが無いので Fastify 自身が 415 を返す(= 64MB を積む経路がそもそも無い)。
    expect(res.statusCode).toBe(415);
    await app.close();
  });

  it('plugin 内でも許可リスト外のルートは 400 で断る', async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(vivliostyleRoutes, { prefix: '/api' });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/build',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from('PK'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('zip 本文');
    await app.close();
  });
});

describe('サイズ上限', () => {
  async function zipApp() {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(vivliostyleRoutes, { prefix: '/api' });
    await app.ready();
    return app;
  }

  it('申告サイズが上限超えなら 1 バイトも読まずに断る', async () => {
    const { config } = await import('../src/config.js');
    const app = await zipApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/build/project',
      headers: {
        'content-type': 'application/zip',
        'content-length': String(config.vivliostyle.build.maxProjectBytes + 1),
      },
      payload: Buffer.from('PK'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('大きすぎます');
    await app.close();
  });

  it('申告を伏せても、実際に読んだバイト数で上限を強制する', async () => {
    // `content-length` は申告値にすぎない(chunked なら付かない)。実測側の上限が
    // 無いと、申告を伏せるだけで上限をすり抜けられる。
    const { config } = await import('../src/config.js');
    const app = await zipApp();
    const over = Buffer.alloc(config.vivliostyle.build.maxProjectBytes + 1024, 0x41);
    const res = await app.inject({
      method: 'POST',
      url: '/api/build/project',
      headers: { 'content-type': 'application/zip', 'transfer-encoding': 'chunked' },
      payload: over,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('大きすぎます');
    await app.close();
  });
});
