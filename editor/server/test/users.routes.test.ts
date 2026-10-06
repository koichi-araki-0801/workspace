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

async function buildApp(
  tweakDeps?: (deps: { users: { listUsers: () => Promise<unknown> } }) => void,
): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { createDeps } = await import('../src/deps.js');
  const { usersRoutes } = await import('../src/routes/users.routes.js');
  const { createFakeSproc, DEFAULT_USERS } = await import('./fakes/sprocFake.js');

  /**
   * seed ユーザー名 → `User`(セッション id = ユーザー名として解決する)。id はフェイク台帳の
   * 公開ID(`u-<username>`)に揃える — 自分自身への操作の判定は公開ID の一致で行うため。
   * `ghost-admin` は台帳に居ない admin のセッション(台帳側で無効化・降格された後も残った
   * セッションに相当)で、操作者を除いた有効 admin の数え方を検証するのに使う。
   */
  function userOf(username: string) {
    if (username === 'ghost-admin') {
      return {
        id: 'u-ghost-admin',
        username,
        displayName: '残存セッション',
        role: 'admin' as const,
        disabled: false,
        mustChangePassword: false,
      };
    }
    const u = DEFAULT_USERS.find((x) => x.username === username);
    if (!u) return null;
    return {
      id: `u-${u.username}`,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      disabled: false,
      mustChangePassword: false,
    };
  }

  const store = createSessionStub({ getSessionUser: (sid) => userOf(sid) });
  const deps = createDeps(await createFakeSproc(), store);
  tweakDeps?.(deps);
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

  it('PATCH /users/:id: 自分自身のロール変更・無効化は 403。表示名の変更は通す', async () => {
    const res = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: '/users/u-admin', headers: as('admin'), payload });
    const disable = await res({ disabled: true });
    expect(disable.statusCode).toBe(403);
    expect(disable.json().message).toMatch(/自分自身/);
    expect((await res({ role: 'editor' })).statusCode).toBe(403);
    // 現状と同じ値の指定は変更ではないので通す(フォームが全項目を送る形を拒否しない)。
    expect((await res({ role: 'admin', disabled: false })).statusCode).toBe(200);
    expect((await res({ displayName: '管理 次郎' })).statusCode).toBe(200);
    const after = (
      await app.inject({ method: 'GET', url: '/users', headers: as('admin') })
    ).json() as Array<{ id: string; role: string; disabled: boolean }>;
    expect(after.find((u) => u.id === 'u-admin')).toMatchObject({ role: 'admin', disabled: false });
  });

  it('PATCH /users/:id: 有効な admin が 0 人になる無効化・降格は 409', async () => {
    const res = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: '/users/u-admin', headers: as('ghost-admin'), payload });
    const disable = await res({ disabled: true });
    expect(disable.statusCode).toBe(409);
    expect(disable.json().message).toMatch(/管理者/);
    expect((await res({ role: 'approver' })).statusCode).toBe(409);
    // 有効な admin がもう 1 人居れば、同じ操作は通る。
    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: as('admin'),
      payload: {
        username: 'admin2',
        displayName: '管理 三郎',
        role: 'admin',
        disabled: false,
        mustChangePassword: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect((await res({ disabled: true })).statusCode).toBe(200);
    // 残る 1 人(admin2)を無効化すると 0 人になるので拒否する。
    const admin2 = created.json().user.id as string;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/users/${admin2}`,
          headers: as('ghost-admin'),
          payload: { disabled: true },
        })
      ).statusCode,
    ).toBe(409);
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

describe('users.routes: 管理者の席の検査と更新の直列化', () => {
  it('2 人の admin が同時に互いを無効化しても、有効な admin が 1 人残る', async () => {
    // 台帳の読み取りを遅らせ、検査 → 更新の間に他方の検査が割り込める状況を作る。
    const app = await buildApp((deps) => {
      const original = deps.users.listUsers.bind(deps.users);
      vi.spyOn(deps.users, 'listUsers').mockImplementation(async () => {
        const snapshot = await original();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return snapshot;
      });
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/users',
        headers: as('admin'),
        payload: {
          username: 'admin2',
          displayName: '管理 三郎',
          role: 'admin',
          disabled: false,
          mustChangePassword: true,
        },
      });
      const admin2 = created.json().user.id as string;
      const disable = (id: string) =>
        app.inject({
          method: 'PATCH',
          url: `/users/${id}`,
          headers: as('ghost-admin'),
          payload: { disabled: true },
        });
      const results = await Promise.all([disable('u-admin'), disable(admin2)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)?.json().code).toBe('LAST_ADMIN');
      const list = (
        await app.inject({ method: 'GET', url: '/users', headers: as('admin') })
      ).json() as Array<{ role: string; disabled: boolean }>;
      expect(list.filter((u) => u.role === 'admin' && !u.disabled)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
