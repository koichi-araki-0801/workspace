// =============================================================================
// spaFallback.test.ts — SPA シェルのフォールバックがフォントの要求を横取りしない
// =============================================================================
// canvas は相対参照のフォントをアプリの URL で取りに行く。そこへ index.html を返すと
// OTS がパースに失敗してエラーになるため、フォント拡張子は 404 を返す。SPA のルートと
// フォント以外の拡張子は従来どおり index.html を返す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-spa-fallback-'));
const webDir = path.join(tmp, 'web');
fs.mkdirSync(webDir, { recursive: true });
const SHELL = '<!doctype html><html><body>SPA-SHELL</body></html>';
fs.writeFileSync(path.join(webDir, 'index.html'), SHELL);
// `config` は import 時に env を読むので、動的 import の前に向ける。
process.env.DATA_ROOT = path.join(tmp, 'data');
process.env.WEB_DIR = webDir;
process.env.AUTH_REQUIRED = 'false';

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SPA フォールバック', () => {
  it.each([
    '/edit/fonts/x.woff2',
    '/edit/fonts/x.woff',
    '/edit/fonts/x.ttf',
    '/edit/fonts/x.otf',
    '/edit/fonts/x.WOFF2',
    '/edit/fonts/x.woff2?v=1',
  ])('フォント %s は 404 で index.html を返さない', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('SPA-SHELL');
  });

  it('SPA のルートは index.html', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/edit/${encodeURIComponent('AM01_510037_20240710_交付版')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA-SHELL');
  });

  it('フォント以外の拡張子は従来どおり index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/edit/x.png' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA-SHELL');
  });

  it('未知の /api/* は 404 JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().kind).toBe('not_found');
  });
});
