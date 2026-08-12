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
import { afterEach, describe, expect, it } from 'vitest';

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
