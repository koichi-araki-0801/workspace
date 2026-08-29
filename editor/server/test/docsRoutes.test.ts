// =============================================================================
// docsRoutes.test.ts — API リファレンス UI(/api/docs)がグローバル CSP で死なないこと
// =============================================================================
// Scalar は起動用スクリプトをインラインで吐く。グローバル CSP は SPA の index.html から
// 採った sha256 ハッシュしか許さないため、専用 CSP が無いと `/api/docs` だけ白紙になる
// (`<div id="app">` のまま何も描画されない)。web 側のテストからは見えない外部向け面なので、
// 「応答本文のインライン script が、その応答の CSP で許可される」ことをここで固定する。
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildCspDirectives } from '../src/config.js';
import { docsRoutes } from '../src/openapi/docsRoutes.js';

/** `app.ts` と同じ順序でグローバル helmet を被せた上に docs を載せる。 */
async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  // ハッシュ列は空 = SPA の index.html が無い(dev)場合。最も厳しい形で試す。
  app.register(helmet, {
    contentSecurityPolicy: { useDefaults: true, directives: buildCspDirectives([]) },
  });
  app.register(docsRoutes);
  // docs の外側にある通常ルート(緩和が漏れていないことの対照)。
  app.get('/api/health', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('GET /api/docs/', () => {
  it('serves the reference page with a CSP that allows its inline bootstrap script', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/docs/' });
      expect(res.statusCode).toBe(200);
      // Scalar の起動 script は src 無しのインライン(= ハッシュ/nonce/unsafe-inline が要る)。
      expect(res.body).toContain('Scalar.createApiReference');
      expect(res.body).toMatch(/<script type="text\/javascript"[^>]*>/);

      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      // グローバル CSP(ハッシュのみ)がそのまま残っていたら白紙になる = 退行。
      expect(csp).not.toBe(undefined);
      expect(/script-src[^;]*sha256-/.test(csp)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps the docs CSP scoped to /api/docs (other routes stay on the global policy)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      const csp = res.headers['content-security-policy'] as string;
      // 通常経路は `'unsafe-inline'` を持たないまま(docs の緩和が漏れていない)。
      expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
