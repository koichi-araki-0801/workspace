// =============================================================================
// staticAssets.test.ts — ビルド済み SPA の静的配信(`@fastify/static`)の契約
// =============================================================================
// `@fastify/static` のメジャー更新で `setHeaders` の第 1 引数が素の `ServerResponse` から
// Fastify の `reply` へ変わり、旧い書き方のままだと全アセットが 500 になった。dist の全ファイルが
// 正しい content-type で返ること、`assets/` だけが immutable で配られること、`index.html` は
// 生ファイルではなく epoch 入りの SPA シェルで返ることを、本番相当の `buildApp` で固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-static-assets-'));
const webDir = path.join(tmp, 'web');
fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
const SHELL = '<!doctype html><html><head><meta name="epoch" content="%APP_EPOCH%"></head></html>';
const JS = /^(text|application)\/javascript/;
const FILES: Record<string, { body: string; type: RegExp }> = {
  'assets/index-abc123.js': { body: 'console.log("app");', type: JS },
  'assets/index-abc123.css': { body: 'body{margin:0}', type: /^text\/css/ },
  'assets/x.js': { body: 'ASSET-X', type: JS },
  'favicon.svg': { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', type: /^image\/svg\+xml/ },
};
fs.writeFileSync(path.join(webDir, 'index.html'), SHELL);
for (const [rel, { body }] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(webDir, rel), body);
}
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

describe('静的配信', () => {
  it('dist の全ファイルが 200・拡張子どおりの content-type で返り、assets/ は immutable', async () => {
    for (const [rel, { body, type }] of Object.entries(FILES)) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await app.inject({ method, url: `/${rel}` });
        expect(res.statusCode, `${method} /${rel}`).toBe(200);
        expect(res.headers['content-type'], `${method} /${rel}`).toMatch(type);
        if (method === 'GET') expect(res.body).toBe(body);
        const cache = String(res.headers['cache-control'] ?? '');
        if (rel.startsWith('assets/')) {
          expect(cache).toBe('public, max-age=31536000, immutable');
        } else {
          expect(cache).not.toContain('immutable');
        }
      }
    }
  });

  it('/index.html を直接要求すると epoch 入りの SPA シェル(no-store)が返る', async () => {
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('<meta name="epoch"');
    expect(res.body).not.toContain('%APP_EPOCH%');
  });

  // 大文字小文字違いや `#` のエンコードで、実在ファイルの経路を迂回して資産が返らないこと。
  // Windows のファイルシステムは大文字小文字を区別しないので、ここが緩むと別名で配信される。
  it.each(['/Assets/x.js', '/assets/X.JS', '/a%23b.js'])(
    '%s は資産を漏らさず SPA シェルか 404',
    async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toBe('ASSET-X');
      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.headers['cache-control']).toBe('no-store');
      } else {
        expect(res.statusCode).toBe(404);
      }
    },
  );
});
