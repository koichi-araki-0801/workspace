// =============================================================================
// parts.routes.test.ts — パーツカタログ + パーツ単位履歴ルートの HTTP 結合テスト
// =============================================================================
// `partsRoutes` を最小の Fastify に単独登録し、`app.inject()` でカタログ sproc(フェイク)と
// ファイル監査ログ(`historyRepo.ts` 経由)の両方を通す。ハーネスは `templates.routes.test.ts`
// と同じ形(`AUTH_REQUIRED=true` の実ガード + `sessionIdFrom` だけ差し替え)。
//
// `fakes/sprocFake.js` は `src/db/sproc.js` → `src/db/pool.js` → `src/config.js` を
// 静的 import で連鎖して引き込む。トップレベルで static import すると env 設定より先に
// config が確定してしまうため、env 設定後の `buildApp()` 内でだけ動的 import する。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-parts-routes-'));
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
  const { partsRoutes } = await import('../src/routes/parts.routes.js');
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
  await app.register(partsRoutes, { deps });
  await app.ready();
  return app;
}

describe('parts.routes', () => {
  let app: FastifyInstance;
  const ID = 'AM01_510037_20240710_交付版';

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('GET /parts/classification-options と GET /parts はカタログ sproc の結果(絞り込みクエリで通す)', async () => {
    const opts = await app.inject({
      method: 'GET',
      url: '/parts/classification-options',
      headers: as('editor'),
    });
    expect(opts.statusCode).toBe(200);
    expect(opts.json().categories).toContain('表紙');
    const list = await app.inject({
      method: 'GET',
      url: `/parts?category=${encodeURIComponent('表紙')}`,
      headers: as('editor'),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).some((p) => p.id === 'p-cover-title')).toBe(true);
  });

  it('POST /templates/:templateId/part-history は 204 で追記し、GET に user 付きで現れる(partKey 欠落は 400)', async () => {
    const url = `/templates/${encodeURIComponent(ID)}/part-history`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: as('editor'),
          payload: { partKey: 'note-a#1', change: '文言修正' },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'POST', url, headers: as('editor'), payload: { change: 'x' } }))
        .statusCode,
    ).toBe(400);
    const got = await app.inject({ method: 'GET', url, headers: as('editor') });
    expect(got.json()).toEqual([
      expect.objectContaining({
        templateId: ID,
        partKey: 'note-a#1',
        change: '文言修正',
        user: 'editor',
      }),
    ]);
  });

  it('POST /templates/:templateId/part-history: viewer は 403、未ログインは 401', async () => {
    const url = `/templates/${encodeURIComponent(ID)}/part-history`;
    const payload = { partKey: 'note-a#1', change: '再修正' };
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url, headers: as('viewer'), payload })).statusCode,
    ).toBe(403);
  });

  // `actor(request)` の `req.user?.username ?? 'system'` は、`AUTH_REQUIRED=true` の他テストでは
  // `requireAuth`/`requireEditor` を通った後にしか呼ばれないため `request.user` が必ず埋まっており
  // 到達しない。ローカルモード(`AUTH_REQUIRED` 未設定)は両ガードとも no-op で `request.user` を
  // 設定しないため、この 1 件だけ `config.ts` を env 差し替え + `vi.resetModules()` で読み直し、
  // 別インスタンスの `partsRoutes` に対して未ログインのまま叩く(`config.paths.test.ts` と同方針)。
  it('ローカルモード(AUTH_REQUIRED 未設定)は未ログインのまま actor を system として記録する', async () => {
    const saved = process.env.AUTH_REQUIRED;
    delete process.env.AUTH_REQUIRED;
    vi.resetModules();
    try {
      const Fastify = (await import('fastify')).default;
      const { errorHandler } = await import('../src/middleware/errorHandler.js');
      const { createDeps } = await import('../src/deps.js');
      const { partsRoutes } = await import('../src/routes/parts.routes.js');
      const { createFakeSproc } = await import('./fakes/sprocFake.js');
      const store = createSessionStub();
      const localApp = Fastify();
      decorateSessionStore(localApp, store);
      localApp.setErrorHandler(errorHandler);
      const deps = createDeps(await createFakeSproc(), store);
      await localApp.register(partsRoutes, { deps });
      await localApp.ready();
      try {
        const url = `/templates/${encodeURIComponent(ID)}/part-history`;
        const posted = await localApp.inject({
          method: 'POST',
          url,
          payload: { partKey: 'note-local#1', change: 'ローカル編集' },
        });
        expect(posted.statusCode).toBe(204);
        const got = await localApp.inject({ method: 'GET', url });
        expect(got.json()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ partKey: 'note-local#1', user: 'system' }),
          ]),
        );
      } finally {
        await localApp.close();
      }
    } finally {
      if (saved === undefined) delete process.env.AUTH_REQUIRED;
      else process.env.AUTH_REQUIRED = saved;
      vi.resetModules();
    }
  });
});
