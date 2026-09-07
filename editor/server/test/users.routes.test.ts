// =============================================================================
// users.routes.test.ts — ユーザ管理ルート(admin 限定)の HTTP 結合テスト
// =============================================================================
// `usersRoutes` を最小の Fastify に単独登録し、`app.inject()` で
// 「実ガード(requireAuth→requireIdentifiedUser→requireAdmin) → validate → repo(sproc
// フェイク) → 監査ログ(audit)」の経路を通す。ハーネスは `templates.routes.test.ts` と
// 同じ形。一時パスワードの文字集合・桁数は `auth/password.ts` の
// `generateTemporaryPassword`(誤読回避の 32 文字集合・12 桁)に合わせる。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-users-routes-'));
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

// `generateTemporaryPassword`(`src/auth/password.ts`)の実装に合わせた一時パスワードの形。
// 誤読しやすい `0`/`O`/`1`/`I`/`l` を落とした 32 文字の大文字英数字 12 桁。
const TEMP_PASSWORD_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;

const as = (username: string) => ({ cookie: username });

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { createDeps } = await import('../src/deps.js');
  const { usersRoutes } = await import('../src/routes/users.routes.js');
  const { createFakeSproc, DEFAULT_USERS } = await import('./fakes/sprocFake.js');

  /** seed ユーザー名 → `User`(セッション id = ユーザー名として解決する)。 */
  function userOf(username: string) {
    const u = DEFAULT_USERS.find((x) => x.username === username);
    if (!u) return null;
    return {
      id: `id-${u.username}`,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      disabled: false,
      mustChangePassword: false,
    };
  }

  const store = createSessionStub({ getSessionUser: (sid) => userOf(sid) });
  const deps = createDeps(await createFakeSproc(), store);
  const app = Fastify();
  decorateSessionStore(app, store);
  app.setErrorHandler(errorHandler);
  await app.register(usersRoutes, { deps });
  await app.ready();
  return app;
}

describe('users.routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('GET /users: admin は 3 人の seed を見る。editor は 403、未ログインは 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/users' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/users', headers: as('editor') })).statusCode,
    ).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/users', headers: as('admin') });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ username: string }>).map((u) => u.username).sort()).toEqual([
      'admin',
      'approver',
      'editor',
    ]);
    // ハッシュ列は 1 つも出ない。
    expect(JSON.stringify(res.json())).not.toMatch(/hash|salt|PW/i);
  });

  it('POST /users: 201 で一時パスワードを 1 回だけ返し、重複ログインIDは 409、規約外の username は 400', async () => {
    const body = {
      username: 'newbie',
      displayName: '新人',
      role: 'editor',
      disabled: false,
      mustChangePassword: true,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: as('admin'),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ username: 'newbie', role: 'editor' });
    expect(res.json().temporaryPassword).toMatch(TEMP_PASSWORD_RE);
    expect(
      (await app.inject({ method: 'POST', url: '/users', headers: as('admin'), payload: body }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/users',
          headers: as('admin'),
          payload: { ...body, username: 'bad name' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('POST /users: editor は 403、未ログインは 401', async () => {
    const body = {
      username: 'blocked',
      displayName: '拒否',
      role: 'editor',
      disabled: false,
      mustChangePassword: true,
    };
    expect((await app.inject({ method: 'POST', url: '/users', payload: body })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/users', headers: as('editor'), payload: body }))
        .statusCode,
    ).toBe(403);
  });

  it('PATCH /users/:id: 部分更新は未指定を据え置き、未知 id は 404', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/users', headers: as('admin') })
    ).json() as Array<{
      id: string;
      username: string;
      displayName: string;
    }>;
    const editor = list.find((u) => u.username === 'editor')!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${editor.id}`,
      headers: as('admin'),
      payload: { displayName: '改名' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'editor', displayName: '改名', role: 'editor' });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/users/no-such-id',
          headers: as('admin'),
          payload: { displayName: 'x' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('POST /users/:id/reset-password: 200 で新しい一時パスワード、未知 id は 404、editor は 403', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/users', headers: as('admin') })
    ).json() as Array<{
      id: string;
      username: string;
    }>;
    const target = list.find((u) => u.username === 'approver')!;
    const res = await app.inject({
      method: 'POST',
      url: `/users/${target.id}/reset-password`,
      headers: as('admin'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().temporaryPassword).toMatch(TEMP_PASSWORD_RE);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/users/no-such-id/reset-password',
          headers: as('admin'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/users/${target.id}/reset-password`,
          headers: as('editor'),
        })
      ).statusCode,
    ).toBe(403);
  });
});
