// =============================================================================
// fundAssets.routes.test.ts — ファンド別画像の単体配信ルートの関所(認証・経路・SVG 検査・ヘッダ)
// =============================================================================
// 画面内プレビューと編集画面が画像を取る唯一の経路。ここが緩むと、検査を通らない SVG が
// 同一オリジンで開ける面になる。迂回入力では 1 バイトも出さないこと、SVG の応答だけ全域 CSP が
// `sandbox` へ置き換わることを主張する。
// 経路は直下 `:file` と会社フォルダ 1 段 `:dir/:file` の 2 本で、深さは経路の形で決める。
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
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const IS_WINDOWS = process.platform === 'win32';
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
  fs.mkdirSync(path.join(imagesDir, 'SMTAM', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, 'SMTAM', 'qr.svg'), GOOD_SVG);
  fs.writeFileSync(path.join(imagesDir, 'SMTAM', 'bad.svg'), BAD_SVG);
  fs.writeFileSync(path.join(imagesDir, 'SMTAM', 'deep', 'x.svg'), GOOD_SVG);
  // URL で意味を持つ字を含む名前(ルートの引数は復号済みなので、字面のまま実体を引く)。
  fs.writeFileSync(path.join(imagesDir, 'a#b.svg'), GOOD_SVG);
  fs.writeFileSync(path.join(imagesDir, '100%.png'), PNG);
  fs.writeFileSync(path.join(imagesDir, '%41.png'), PNG);
  fs.writeFileSync(path.join(imagesDir, 'SMTAM', 'q#r.svg'), GOOD_SVG);
  // Windows は `?` をファイル名に使えない(純粋関数のテストで担保する)。
  if (!IS_WINDOWS) fs.writeFileSync(path.join(imagesDir, 'a?b.png'), PNG);
  // NTFS の代替データストリーム(作れない環境では存在しないファイルとして 404 になるだけ)。
  try {
    fs.writeFileSync(path.join(imagesDir, '510037_logo.svg:s.svg'), GOOD_SVG);
    fs.writeFileSync(path.join(imagesDir, 'SMTAM', 'qr.svg:s.svg'), GOOD_SVG);
  } catch {
    // 代替データストリームを作れない環境
  }
  // リンクの会社フォルダ(Windows は junction を権限なしで作れる)。作れない環境では存在しない
  // フォルダとして 404 になるだけなので、下のテストはどちらでも成立する。
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'x.svg'), GOOD_SVG);
  try {
    fs.symlinkSync(outside, path.join(imagesDir, 'linked'), 'junction');
  } catch {
    // リンクを作れない環境
  }
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
    ['2 段のサブフォルダ', `${URL_BASE}/SMTAM/deep/x.svg`],
    ['%2F で 2 段を 1 段に偽装', `${URL_BASE}/SMTAM/deep%2Fx.svg`],
    ['%2F でフォルダを偽装', `${URL_BASE}/SMTAM%2Fdeep/x.svg`],
    ['フォルダが ..', `${URL_BASE}/%2e%2e/510037_logo.svg`],
    ['予約名のフォルダ', `${URL_BASE}/CON/510037_logo.svg`],
    ['会社フォルダの違反 SVG', `${URL_BASE}/smtam/bad.svg`],
    ['リンクの会社フォルダ', `${URL_BASE}/linked/x.svg`],
    ['存在しない会社フォルダ', `${URL_BASE}/nope/qr.svg`],
    ['末尾が . のフォルダ', `${URL_BASE}/smtam./qr.svg`],
    ['末尾が空白のフォルダ', `${URL_BASE}/smtam%20/qr.svg`],
    [': を含むファイル名(代替データストリーム)', `${URL_BASE}/510037_logo.svg:s.svg`],
    [': を含むフォルダ配下のファイル名', `${URL_BASE}/smtam/qr.svg:s.svg`],
    [': を含むフォルダ', `${URL_BASE}/a:b/qr.svg`],
    ['末尾が . のファイル名', `${URL_BASE}/smtam/qr.svg.`],
    ['予約名', `${URL_BASE}/CON.svg`],
    ['予約名(小文字・拡張子付き)', `${URL_BASE}/com1.png`],
    ['許可外の拡張子', `${URL_BASE}/510037_anim.gif`],
    ['存在しない', `${URL_BASE}/510037_none.svg`],
    ['%00(NUL)', `${URL_BASE}/510037_logo.svg%00`],
    ['%5C%5C で UNC を偽装', `${URL_BASE}/%5C%5Chost%5Cshare%5Cx.svg`],
    ['ドライブ指定', `${URL_BASE}/C%3A%5Cx.svg`],
    ['末尾が空白のファイル名', `${URL_BASE}/510037_logo.svg%20`],
    ['末尾が . のファイル名(直下)', `${URL_BASE}/510037_logo.svg.`],
    ['%252e%252e のフォルダ(字面の名前として探して無い)', `${URL_BASE}/%252e%252e/510037_logo.svg`],
  ])('%s は 404 で、本文を出さない', async (_label, url) => {
    const res = await app.inject({ method: 'GET', url, headers: as('viewer') });
    expect(res.statusCode, `${url} → ${res.statusCode}`).toBe(404);
    expect(res.body).not.toContain('SECRET_CSS');
    expect(res.body).not.toContain('<svg');
  });
});

describe('URL で意味を持つ字を含むファイル名', () => {
  const get = (url: string) => app.inject({ method: 'GET', url, headers: as('viewer') });

  it('# を含む名前を返す(引数を # で切らない)', async () => {
    const res = await get(`${URL_BASE}/${encodeURIComponent('a#b.svg')}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(GOOD_SVG);
  });

  it.skipIf(IS_WINDOWS)('? を含む名前を返す(引数を ? で切らない)', async () => {
    const res = await get(`${URL_BASE}/${encodeURIComponent('a?b.png')}`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG);
  });

  it('% を含む名前を返す(引数をもう一度は復号しない)', async () => {
    for (const name of ['100%.png', '%41.png']) {
      const res = await get(`${URL_BASE}/${encodeURIComponent(name)}`);
      expect(res.statusCode, name).toBe(200);
      expect(res.rawPayload).toEqual(PNG);
    }
    // `%41` を `A` と読み替えない。
    expect((await get(`${URL_BASE}/A.png`)).statusCode).toBe(404);
  });

  it('会社フォルダの中の # を含む名前を返す', async () => {
    const res = await get(`${URL_BASE}/smtam/${encodeURIComponent('q#r.svg')}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(GOOD_SVG);
  });
});

describe('GET /api/fund-assets/images/:dir/:file', () => {
  it('認証なしは 401', async () => {
    const res = await app.inject({ method: 'GET', url: `${URL_BASE}/smtam/qr.svg` });
    expect(res.statusCode).toBe(401);
  });

  it('会社フォルダの SVG を返す(参照 smtam で実フォルダ SMTAM を引く)', async () => {
    for (const dir of ['smtam', 'SMTAM']) {
      const res = await app.inject({
        method: 'GET',
        url: `${URL_BASE}/${dir}/qr.svg`,
        headers: as('viewer'),
      });
      expect(res.statusCode, dir).toBe(200);
      expect(res.body).toBe(GOOD_SVG);
      expect(res.headers['content-type']).toContain('image/svg+xml');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toBe('sandbox');
    }
  });

  it('会社コードとの照合はしない(サーバは深さ 1 までだけを検査する)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/sub/510037_deep.svg`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/fund-assets/inspect', () => {
  const INSPECT_URL = '/api/fund-assets/inspect';
  type Ref = { dir: string | null; file: string };
  const inspect = (refs: Ref[], headers: Record<string, string> = as('viewer')) =>
    app.inject({ method: 'POST', url: INSPECT_URL, headers, payload: { refs } });

  it('認証なしは 401', async () => {
    const res = await inspect([{ dir: null, file: '510037_logo.svg' }], {});
    expect(res.statusCode).toBe(401);
  });

  it('直下の画像を ok / svg_rejected(検査の文言付き)/ missing で返し、中身を含めない', async () => {
    const { inspectSvg } = await import('@editor/shared');
    const res = await inspect([
      { dir: null, file: '510037_logo.svg' },
      { dir: null, file: '510037_bad.svg' },
      { dir: null, file: '510037_none.svg' },
      { dir: null, file: '510037_photo.png' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { dir: null, file: '510037_logo.svg', status: 'ok' },
        {
          dir: null,
          file: '510037_bad.svg',
          status: 'svg_rejected',
          violations: inspectSvg(BAD_SVG),
        },
        { dir: null, file: '510037_none.svg', status: 'missing' },
        { dir: null, file: '510037_photo.png', status: 'ok' },
      ],
    });
    expect(inspectSvg(BAD_SVG).length).toBeGreaterThan(0);
    expect(res.body).not.toContain('<svg');
    expect(res.body).not.toContain('<rect');
  });

  it('会社フォルダの画像も同じ判定(フォルダ名は大小文字を区別しない)', async () => {
    const { inspectSvg } = await import('@editor/shared');
    const res = await inspect([
      { dir: 'smtam', file: 'qr.svg' },
      { dir: 'SMTAM', file: 'bad.svg' },
      { dir: 'smtam', file: 'none.svg' },
      { dir: 'nope', file: 'qr.svg' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { dir: 'smtam', file: 'qr.svg', status: 'ok' },
      { dir: 'SMTAM', file: 'bad.svg', status: 'svg_rejected', violations: inspectSvg(BAD_SVG) },
      { dir: 'smtam', file: 'none.svg', status: 'missing' },
      { dir: 'nope', file: 'qr.svg', status: 'missing' },
    ]);
    expect(res.body).not.toContain('<svg');
  });

  it.each<[string, Ref]>([
    ['..', { dir: null, file: '..' }],
    ['/ で区切ったサブフォルダ', { dir: null, file: 'sub/510037_deep.svg' }],
    [' で区切ったサブフォルダ', { dir: null, file: 'sub\u2901f_deep.svg' }],
    ['.. で css へ遡る', { dir: null, file: '../css/510037.css' }],
    ['フォルダが ..', { dir: '..', file: '510037_logo.svg' }],
    ['/ で 2 段を 1 段に偽装', { dir: 'SMTAM', file: 'deep/x.svg' }],
    ['/ でフォルダを偽装', { dir: 'SMTAM/deep', file: 'x.svg' }],
    ['.. でフォルダの外へ', { dir: 'smtam', file: '../510037_logo.svg' }],
    ['リンクの会社フォルダ', { dir: 'linked', file: 'x.svg' }],
    ['予約名', { dir: null, file: 'CON.svg' }],
    ['許可外の拡張子', { dir: null, file: '510037_anim.gif' }],
    ['末尾が . のファイル名', { dir: null, file: '510037_logo.svg.' }],
    ['空の名前', { dir: null, file: '' }],
  ])('%s は missing(配信ルートと同じ判定)', async (_label, ref) => {
    const res = await inspect([ref]);
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([{ ...ref, status: 'missing' }]);
    expect(res.body).not.toContain('SECRET_CSS');
    expect(res.body).not.toContain('<svg');
  });

  it('50 件までは受け付け、51 件は 400', async () => {
    const refs = (n: number) =>
      Array.from({ length: n }, () => ({ dir: null, file: '510037_logo.svg' }));
    const ok = await inspect(refs(50));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results).toHaveLength(50);
    expect((await inspect(refs(51))).statusCode).toBe(400);
  });

  it('形の違う本文は 400', async () => {
    for (const payload of [{}, { refs: 'x' }, { refs: [{ file: 1 }] }, { refs: [{ dir: null }] }]) {
      const res = await app.inject({
        method: 'POST',
        url: INSPECT_URL,
        headers: as('viewer'),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('単体配信ルートの 404 は今のまま理由を出さない', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/510037_bad.svg`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
  });
});
