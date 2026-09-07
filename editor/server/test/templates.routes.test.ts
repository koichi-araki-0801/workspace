// =============================================================================
// templates.routes.test.ts — テンプレート集約ルートの HTTP 結合テスト(sproc フェイク)
// =============================================================================
// `templatesRoutes` を最小の Fastify に単独登録し、`app.inject()` で「ガード →
// クエリ整形 → repo(sproc フェイク/ファイル I/O) → 応答」の経路を通す。認可ゲートは
// `AUTH_REQUIRED=true` で実ガード(`requireAuth`/`requireEditor`)を通し、`sessionIdFrom`
// だけを差し替えてロール切替をヘッダ駆動にする(`generate.routes.test.ts` と同方針)。
//
// `sessionIdFrom` の実装は `cookieHeader: string | undefined` の 1 引数(`loadUser` が
// `req.headers.cookie` だけを渡す)なので、モックは受け取った文字列をそのままセッション id
// として扱う(名前解析・形式検査を迂回する)。テストは `Cookie` ヘッダへユーザー名を直接
// 積むことでロールを選ぶ。
//
// `fakes/sprocFake.js` は `src/db/sproc.js` → `src/db/pool.js` → `src/config.js` を
// 静的 import で連鎖して引き込む。ESM は import 先を先に評価するため、この 1 行を
// トップレベルで static import すると、下の env 設定より**先に** config が確定してしまい
// (実の `dataRoot` を読む)、テストが本物の `editor-data` を覗く事故になる。
// env 設定が終わった後の `buildApp()` 内でだけ動的 import する。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-templates-routes-'));
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'false';
process.env.DATA_ROOT = path.join(root, 'data');
process.env.GIT_REPO_DIR = path.join(root, 'data');
process.env.TEMPLATES_DIR = path.join(root, 'data', 'templates');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.DRAFTS_DIR = path.join(root, 'data', 'drafts');
process.env.PENDING_DIR = path.join(root, 'data', 'pending');
process.env.SYNC_DIR = path.join(root, 'data', 'sync');
process.env.LOG_DIR = path.join(root, 'logs');

const as = (username: string) => ({ cookie: username });

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { createDeps } = await import('../src/deps.js');
  const { templatesRoutes } = await import('../src/routes/templates.routes.js');
  const { createFakeSproc, DEFAULT_USERS } = await import('./fakes/sprocFake.js');

  /** seed ユーザー名 → `User`(セッション id = ユーザー名として解決する)。 */
  function userOf(username: string) {
    const u = DEFAULT_USERS.find((x) => x.username === username);
    if (u) {
      return {
        id: `id-${u.username}`,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        disabled: false,
        mustChangePassword: false,
      };
    }
    // seed に居ない閲覧専用ロール(viewer)。変更系ルートの 403 を確かめるために足す。
    if (username === 'viewer') {
      return {
        id: 'id-viewer',
        username: 'viewer',
        displayName: '閲覧',
        role: 'viewer' as const,
        disabled: false,
        mustChangePassword: false,
      };
    }
    return null;
  }

  const store = createSessionStub({ getSessionUser: (sid) => userOf(sid) });
  const deps = createDeps(await createFakeSproc(), store);
  const app = Fastify();
  decorateSessionStore(app, store);
  app.setErrorHandler(errorHandler);
  await app.register(templatesRoutes, { deps });
  await app.ready();
  return app;
}

describe('templates.routes', () => {
  let app: FastifyInstance;
  const ID = 'AM01_510037_20240710_交付版';

  beforeAll(async () => {
    fs.mkdirSync(path.join(root, 'data', 'templates'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'css'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'templates', `${ID}.html`),
      '<html><body><p>{{ fund.name }}</p></body></html>',
      'utf8',
    );
    fs.writeFileSync(path.join(root, 'data', 'css', '510037.css'), 'body{}', 'utf8');
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('GET /templates/options: 台帳 sproc の候補を 4 配列へ束ねる(未ログインは 401)', async () => {
    expect((await app.inject({ method: 'GET', url: '/templates/options' })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: '/templates/options?companyCode=AM01',
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.companyCodes).toEqual(['AM01']);
    expect(body.fundCodes).toContain('510037');
    expect(body.editionTypes).toEqual(expect.arrayContaining(['交付版', '全体版']));
  });

  it('GET /templates/options: クエリが配列(文字列でない)値のキーは無視する', async () => {
    // `?companyCode=a&companyCode=b` は Fastify のクエリ解析で配列になる。`toQuery` が
    // 文字列でない値を無視して素通しすることを固定する。台帳の会社は 1 件なので、
    // 絞り込みが効いた場合と応答は区別できない(見ているのは 500 にならないことと候補の形)。
    const res = await app.inject({
      method: 'GET',
      url: '/templates/options?companyCode=AM01&companyCode=AM02',
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().companyCodes).toEqual(['AM01']);
  });

  it('GET /templates/series: companyCode と editionType が無ければ 400、あれば版種で絞った台帳行', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/templates/series?companyCode=AM01',
          headers: as('editor'),
        })
      ).statusCode,
    ).toBe(400);
    // companyCode 側だけが欠けているケースも踏んでおく(2 パラメータのどちらが欠けても 400)。
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/templates/series?editionType=${encodeURIComponent('交付版')}`,
          headers: as('editor'),
        })
      ).statusCode,
    ).toBe(400);
    const res = await app.inject({
      method: 'GET',
      url: `/templates/series?companyCode=AM01&editionType=${encodeURIComponent('交付版')}`,
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as Array<{ attributes: { editionType: string } }>).every(
        (m) => m.attributes.editionType === '交付版',
      ),
    ).toBe(true);
  });

  it('GET /templates: ファイル走査由来の一覧を属性クエリで絞る(空文字のクエリは無視)', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/templates?fundCode=',
      headers: as('editor'),
    });
    expect(all.json()).toHaveLength(1);
    const none = await app.inject({
      method: 'GET',
      url: '/templates?fundCode=999999',
      headers: as('editor'),
    });
    expect(none.json()).toEqual([]);
  });

  it('GET /templates/:id と /funds/:fundCode/sample-data', async () => {
    const t = await app.inject({
      method: 'GET',
      url: `/templates/${encodeURIComponent(ID)}`,
      headers: as('editor'),
    });
    expect(t.statusCode).toBe(200);
    expect(t.json().meta.status).toBe('published');
    expect(t.json().css).toBe('body{}');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/templates/AM01_999999_20240710_交付版',
          headers: as('editor'),
        })
      ).statusCode,
    ).toBe(404);
    const s = await app.inject({
      method: 'GET',
      url: '/funds/110024/sample-data',
      headers: as('editor'),
    });
    expect(s.statusCode).toBe(200);
    expect(s.json().fund.name).toBe('高金利ソブリンオープン');
  });

  it('PUT /templates/:id/draft: body の templateId が URL と違えば 400、一致すれば 204 で drafts に書く。GET は保存内容、DELETE は 204 で消す', async () => {
    const url = `/templates/${encodeURIComponent(ID)}/draft`;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers: as('editor'),
          payload: { templateId: 'AM01_510037_20240710_全体版', html: '<p>x</p>', css: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers: as('editor'),
          payload: { templateId: ID, html: '<p>draft</p>', css: '.d{}' },
        })
      ).statusCode,
    ).toBe(204);
    expect(fs.existsSync(path.join(root, 'data', 'drafts', `${ID}.html`))).toBe(true);
    const got = await app.inject({ method: 'GET', url, headers: as('editor') });
    expect(got.json()).toMatchObject({ templateId: ID, html: '<p>draft</p>', css: '.d{}' });
    expect((await app.inject({ method: 'DELETE', url, headers: as('editor') })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: 'GET', url, headers: as('editor') })).body).toBe('null');
  });

  it('PUT /templates/:id/draft: viewer は 403、未ログインは 401', async () => {
    const url = `/templates/${encodeURIComponent(ID)}/draft`;
    const payload = { templateId: ID, html: '<p>x</p>', css: '' };
    expect((await app.inject({ method: 'PUT', url, payload })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'PUT', url, headers: as('viewer'), payload })).statusCode,
    ).toBe(403);
  });

  it('GET /templates/:id/sync-status: 同期状態ファイルが無くても 200 でペア候補 id を返す', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/templates/${encodeURIComponent(ID)}/sync-status`,
      headers: as('editor'),
    });
    expect(res.statusCode).toBe(200);
    // 交付版⇄全体版のペア名は幾何ではなく文字列変換(`pairedTemplateId`)で決まる。
    expect(res.json().pairTemplateId).toBe('AM01_510037_20240710_全体版');
  });
});
