// =============================================================================
// fundAssets.routes.test.ts — ファンド別画像の単体配信ルートの関所(認証・経路・SVG 検査・ヘッダ)
// =============================================================================
// 画面内プレビューと編集画面が画像を取る唯一の経路。ここが緩むと、検査を通らない SVG が
// 同一オリジンで開ける面になる。迂回入力では 1 バイトも出さないこと、SVG の応答だけ全域 CSP が
// `sandbox` へ置き換わることを主張する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

vi.mock('../src/auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/session.js')>()),
  sessionIdFrom: (cookieHeader: string | undefined) => cookieHeader || undefined,
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fund-assets-'));
const imagesDir = path.join(root, 'data', 'images');
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'false';
process.env.DATA_ROOT = path.join(root, 'data');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.IMAGES_DIR = imagesDir;
process.env.LOG_DIR = path.join(root, 'logs');

const NS = 'http://www.w3.org/2000/svg';
const GOOD_SVG = `<svg xmlns="${NS}" width="10" height="10"><rect width="10" height="10"/></svg>`;
const BAD_SVG = `<svg xmlns="${NS}" onload="alert(1)"><rect width="10" height="10"/></svg>`;
const as = (sid: string) => ({ cookie: sid });
const URL_BASE = '/api/fund-assets/images';

let app: FastifyInstance;

beforeAll(async () => {
  fs.mkdirSync(path.join(imagesDir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'css'), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
  fs.writeFileSync(path.join(imagesDir, '510037_bad.svg'), BAD_SVG);
  fs.writeFileSync(path.join(imagesDir, '510037_photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(imagesDir, '510037_anim.gif'), 'GIF89a');
  fs.writeFileSync(path.join(imagesDir, 'sub', '510037_deep.svg'), GOOD_SVG);
  fs.writeFileSync(path.join(root, 'data', 'css', '510037.css'), 'SECRET_CSS{}');

  const Fastify = (await import('fastify')).default;
  const helmet = (await import('@fastify/helmet')).default;
  const { buildCspDirectives } = await import('../src/config.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { fundAssetsRoutes } = await import('../src/routes/fundAssets.routes.js');
  const store = createSessionStub({
    getSessionUser: (sid) =>
      sid === 'viewer'
        ? {
            id: 'id-viewer',
            username: 'viewer',
            displayName: '閲覧',
            role: 'viewer' as const,
            disabled: false,
            mustChangePassword: false,
          }
        : null,
  });
  app = Fastify();
  app.decorateRequest('user', undefined);
  decorateSessionStore(app, store);
  app.setErrorHandler(errorHandler);
  // `app.ts` と同じ順序: helmet(全域)→ ルート。SVG の CSP は onSend で上書きする。
  app.register(helmet, {
    contentSecurityPolicy: { useDefaults: true, directives: buildCspDirectives([]) },
  });
  app.register(fundAssetsRoutes, { prefix: '/api' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GET /api/fund-assets/images/:file', () => {
  it('認証なしは 401', async () => {
    const res = await app.inject({ method: 'GET', url: `${URL_BASE}/510037_logo.svg` });
    expect(res.statusCode).toBe(401);
  });

  it('SVG を image/svg+xml・nosniff・no-store・CSP sandbox で返す', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/510037_logo.svg`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(GOOD_SVG);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('png は image/png で返し、CSP は全域のまま', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/510037_photo.png`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('検査に違反した SVG は 404 で、本文を出さない', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/510037_bad.svg`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('onload');
  });

  it.each([
    ['..', `${URL_BASE}/..`],
    ['%2F で区切ったサブフォルダ', `${URL_BASE}/sub%2F510037_deep.svg`],
    ['%5C で区切ったサブフォルダ', `${URL_BASE}/sub%5C510037_deep.svg`],
    ['%2F で css へ遡る', `${URL_BASE}/..%2Fcss%2F510037.css`],
    ['二重符号化の ..', `${URL_BASE}/%252e%252e%252Fcss%252F510037.css`],
    ['サブフォルダ', `${URL_BASE}/sub/510037_deep.svg`],
    ['予約名', `${URL_BASE}/CON.svg`],
    ['予約名(小文字・拡張子付き)', `${URL_BASE}/com1.png`],
    ['許可外の拡張子', `${URL_BASE}/510037_anim.gif`],
    ['存在しない', `${URL_BASE}/510037_none.svg`],
  ])('%s は 404 で、本文を出さない', async (_label, url) => {
    const res = await app.inject({ method: 'GET', url, headers: as('viewer') });
    expect(res.statusCode, `${url} → ${res.statusCode}`).toBe(404);
    expect(res.body).not.toContain('SECRET_CSS');
    expect(res.body).not.toContain('<svg');
  });
});
