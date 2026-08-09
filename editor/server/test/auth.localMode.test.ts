// =============================================================================
// auth.localMode.test.ts — 認証を課さない構成(`AUTH_REQUIRED` が偽)での姿勢の固定
// =============================================================================
// `requireAuth` / `requireEditor` は `if (!config.requireAuth) return;` で素通りする。
// これはデータ系ルートをローカルモードで開放するための**意図的な**設計なので、黙って
// 通るのではなく「通ることが契約」としてここで固定する。
//
// 一方、資格情報を書き換える経路は同じ区分に属さない。本人一致検査を
// `if (request.user && request.user.username !== body.username)` で書くと、`request.user` を
// 埋めない構成では条件式ごと消え、**未認証で任意アカウントのパスワードを書き換えられる**。
// `requireIdentifiedUser` は `config` を見ないので、この構成でも 401 になる。
// `AUTH_REQUIRED` を立てないのが本ファイルの主眼なので、他のテストと同居させない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-local-mode-'));
process.env.DATA_ROOT = tmp;
// config は起動時に env を読む。「未設定」の配備を再現するため、値の代入ではなく削除する。
delete process.env.AUTH_REQUIRED;

const initPassword = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../src/repositories/authRepo.js', () => ({
  login: vi.fn(),
  logout: vi.fn(async () => {}),
  initPassword: (...args: unknown[]) => initPassword(...(args as [])),
}));

vi.mock('../src/auth/session.js', () => ({
  cookieOptions: {},
  createSession: vi.fn(async () => 'sid'),
  destroySession: vi.fn(async () => {}),
  sessionIdFrom: () => undefined,
  getSessionUser: async () => null,
}));

const reply = {} as FastifyReply;
const anonymous = {} as unknown as FastifyRequest;

describe('ローカルモード(認証を課さない構成)', () => {
  let app: FastifyInstance;
  let guards: typeof import('../src/middleware/auth.js');

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { config } = await import('../src/config.js');
    expect(config.requireAuth).toBe(false);
    guards = await import('../src/middleware/auth.js');
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { authRoutes } = await import('../src/routes/auth.routes.js');
    app = Fastify();
    app.decorateRequest('user', undefined);
    app.setErrorHandler(errorHandler);
    await app.register(authRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lets the data-route guards pass through (intentional)', async () => {
    await expect(guards.requireAuth(anonymous, reply)).resolves.toBeUndefined();
    await expect(guards.requireEditor(anonymous, reply)).resolves.toBeUndefined();
    await expect(guards.requireApprover(anonymous, reply)).resolves.toBeUndefined();
    await expect(guards.requireAdmin(anonymous, reply)).resolves.toBeUndefined();
  });

  // ★ ガードの発火条件を設定値へ従属させない。`AUTH_REQUIRED` を書き損じた配備
  // (`AUTH_REQUIRED=1` が偽へ倒れる等)でも、資格情報の書き換えは通らない。
  it('still refuses init-password and never reaches the repository', async () => {
    await expect(guards.requireIdentifiedUser(anonymous, reply)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/init-password',
      payload: { username: 'admin', currentPassword: 'x', newPassword: 'new-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(initPassword).not.toHaveBeenCalled();
  });
});
