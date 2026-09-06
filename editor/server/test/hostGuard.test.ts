// =============================================================================
// hostGuard.test.ts — `Host` ヘッダの検査が入口で効くこと
// =============================================================================
// 塞ぐのは DNS リバインディング。攻撃者ページは自分のドメインの DNS を後から
// `127.0.0.1` へ向け替えられる。ブラウザは「まだ attacker.example と同一オリジン」と
// 考えたまま要求を出すため SameSite も CORS も効かず、唯一食い違うのが `Host` である。
//
// 効きどころは**認証を課さない配備**(既定の local モード)で、そこでは実質「loopback に
// 到達できること」だけが認可条件になっている。したがってここでは認証オフの構成で
// 「素通りしないこと」を主張する — 認証オンで 401 になるのは別の層の効果であり、
// この層の検証にならない。
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.AUTH_REQUIRED = 'false';

/**
 * `app.ts` の入口フックと同じ形を最小構成で組む。実 `app.ts` は import 時に dataRoot や
 * web dist を触るため、ここでは**検査そのもの**(`allowedHosts` + `isAllowedHost` + 403)を
 * 同じ実装で組み立てて主張する。実装が 1 つなので、置き場所が変わっても追随する。
 */
async function buildApp(): Promise<FastifyInstance> {
  const { allowedHosts, isAllowedHost } = await import('../src/config.js');
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    if (isAllowedHost(request.headers.host, allowedHosts)) return;
    await reply.code(403).send();
  });
  app.get('/api/health', async () => ({ ok: true, secret: 'internal-marker' }));
  app.post('/api/generate', async () => ({ started: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('Host ヘッダの検査', () => {
  it('loopback 名は通る(既存の運用を壊さない)', async () => {
    app = await buildApp();
    for (const host of ['localhost:24680', '127.0.0.1:24680', '[::1]:24680', 'LOCALHOST']) {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
  });

  it('攻撃者ドメインを名乗る要求は 403 で、本文を 1 バイトも返さない', async () => {
    app = await buildApp();
    for (const host of [
      'attacker.example',
      'attacker.example:24680',
      // 前方一致・後方一致で通してしまう実装への回帰網。
      'localhost.attacker.example',
      'attackerlocalhost',
      '127.0.0.1.attacker.example',
    ]) {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(403);
      // 存在オラクルにしない(本文で「この経路は在る」と教えない)。
      expect(res.body, host).not.toContain('internal-marker');
    }
  });

  it('変更系ルートも同じ入口で落ちる(検査はルートごとではない)', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/generate',
      headers: { host: 'attacker.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('started');
  });
});

// ── 実配線(`buildApp()`)への統合テスト ──
//
// 上の describe が主張しているのは「`isAllowedHost` + 403 という**形**が正しく振る舞う」
// ことであって、「実 `app.ts` がその形で配線されている」ことではない。`app.ts` は
// `buildApp()` 工場になり、listen もシグナル処理も `index.ts` 側にあるので、ここでは
// **本番と同じインスタンス**を `inject()` で叩く(再構築形が原理的に見られない「フックの
// 順序」と「実ルートでも本文を返さないこと」は、この describe だけが押さえている)。
// 実 `app.ts` の dynamic import は全ルート登録と web dist の探索を伴い、ルート CI
// (4 project 並列 + coverage) では既定 5s を超えて落ちることがある(単独なら 1s 前後)。
// 遅いこと自体は退行ではないので、上限は `projectInput.test.ts` と同じく実測へ合わせる。
describe('実 app.ts の Host 検査(buildApp の実配線)', { timeout: 60_000 }, () => {
  it('loopback 名は実ルートへ通り、攻撃者ドメインは本文ゼロの 403 になる', async () => {
    const { buildApp } = await import('../src/app.js');
    app = buildApp();
    const ok = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost' },
    });
    expect(ok.statusCode).toBe(200);

    for (const host of ['attacker.example', 'localhost.attacker.example', '127.0.0.1.attacker']) {
      const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(res.body, host).toBe('');
    }
  });

  it('ルートに当たらない要求も入口で落ちる(検査はルーティングより前)', async () => {
    const { buildApp } = await import('../src/app.js');
    app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/no-such-route',
      headers: { host: 'attacker.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
  });

  it('認証オフの配備でも 403 になる(設定 1 つでガードが消える形にしていない)', async () => {
    // この層の効きどころは認証を課さない local モード。上の 2 ケースは
    // `AUTH_REQUIRED=false` のまま走っているので、その事実がここで主張になる。
    const { config: loaded } = await import('../src/config.js');
    expect(loaded.requireAuth).toBe(false);
  });

  it('認証オンの配備では認証前ゲートより先に効く(フックの順序)', async () => {
    // 認証前ゲート(`onRequest`)は zip の content-type を見て未認証を 401 にする。攻撃者
    // ドメイン宛でそれが 401 になるなら Host 検査は後ろにある。403 であることが「Host 検査が
    // 先頭のフック」であることの実測になる。
    const previous = process.env.AUTH_REQUIRED;
    process.env.AUTH_REQUIRED = 'true';
    vi.resetModules();
    try {
      const { buildApp } = await import('../src/app.js');
      app = buildApp();
      const zip = { 'content-type': 'application/zip' };
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/build/project',
        headers: { ...zip, host: 'attacker.example' },
        payload: Buffer.from('PK'),
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.body).toBe('');

      // 認証前ゲート自体は生きていること(上の 403 が「ゲート不在」ではないことの対照)。
      const unauth = await app.inject({
        method: 'POST',
        url: '/api/build/project',
        headers: { ...zip, host: 'localhost' },
        payload: Buffer.from('PK'),
      });
      expect(unauth.statusCode).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.AUTH_REQUIRED;
      else process.env.AUTH_REQUIRED = previous;
      vi.resetModules();
    }
  });
});
