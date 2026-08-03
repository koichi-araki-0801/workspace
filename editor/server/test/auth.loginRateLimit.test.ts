// =============================================================================
// auth.loginRateLimit.test.ts — ログインルートの試行回数制限(結合テスト)
// =============================================================================
// `POST /auth/login` は唯一の未認証 KDF 到達点で、以前は無制限だった: 総当たりも、
// PBKDF2(12 万回反復)を空回しさせる CPU 枯渇も、ここを何度でも通れた。
// 資格情報の検証自体は repo の責務なのでモックし、「ルートが何回リポジトリまで通したか」
// と「拒否後に応答が変わるか」だけを見る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unauthorized } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// config を import する前に、監査ログの書き出し先を一時ディレクトリへ逃がす。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-login-rate-'));
process.env.DATA_ROOT = tmp;
process.env.AUTH_REQUIRED = 'true';

// 戻り値を `Promise<unknown>` と明示する: 既定実装は throw のみなので、注釈が無いと
// `never` に推論され、成功系を差し込む `mockImplementationOnce` が型エラーになる。
const login = vi.fn(async (_req: unknown): Promise<unknown> => {
  throw unauthorized('ユーザーIDまたはパスワードが違います');
});

vi.mock('../src/repositories/authRepo.js', () => ({
  login: (...args: unknown[]) => login(...(args as [])),
  logout: vi.fn(async () => {}),
  initPassword: vi.fn(async () => {}),
}));

vi.mock('../src/auth/session.js', () => ({
  cookieOptions: {},
  createSession: vi.fn(async () => 'sid'),
  destroySession: vi.fn(async () => {}),
  sessionIdFrom: () => undefined,
  getSessionUser: async () => null,
}));

const post = (app: FastifyInstance, username: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { username, password: 'wrong' } });

describe('POST /auth/login のレート制限', () => {
  let app: FastifyInstance;
  let maxFailures: number;
  let resetLoginRateLimit: () => void;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { authRoutes } = await import('../src/routes/auth.routes.js');
    const rate = await import('../src/auth/loginRateLimit.js');
    maxFailures = rate.LOGIN_MAX_FAILURES;
    resetLoginRateLimit = rate.resetLoginRateLimit;
    app = Fastify();
    app.setErrorHandler(errorHandler);
    // 成功系は `reply.setCookie` を使うため、本番同様に cookie プラグインを載せる。
    await app.register((await import('@fastify/cookie')).default);
    await app.register(authRoutes);
    await app.ready();
  });

  beforeEach(() => {
    resetLoginRateLimit();
    login.mockClear();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('answers 401 while under the threshold and reaches the repository each time', async () => {
    for (let i = 0; i < maxFailures; i += 1) {
      const res = await post(app, 'admin');
      expect(res.statusCode).toBe(401);
    }
    expect(login).toHaveBeenCalledTimes(maxFailures);
  });

  it('rejects further attempts with 403 without running the KDF again', async () => {
    for (let i = 0; i < maxFailures; i += 1) await post(app, 'admin');
    login.mockClear();

    const res = await post(app, 'admin');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ kind: 'forbidden', code: 'LOGIN_RATE_LIMITED' });
    // 拒否は KDF より手前。リポジトリ(= PBKDF2)まで一切降りない。
    expect(login).not.toHaveBeenCalled();
  });

  it('does not lock out a different login id from the same IP', async () => {
    for (let i = 0; i < maxFailures; i += 1) await post(app, 'admin');

    const res = await post(app, 'editor');
    expect(res.statusCode).toBe(401);
  });

  it('clears the counter on a successful login', async () => {
    for (let i = 0; i < maxFailures - 1; i += 1) await post(app, 'admin');
    login.mockImplementationOnce(async () => ({
      result: {
        user: {
          id: 'u1',
          username: 'admin',
          displayName: 'admin',
          role: 'admin',
          disabled: false,
          mustChangePassword: false,
        },
        mustChangePassword: false,
      },
      sessionId: 'sid',
    }));
    expect((await post(app, 'admin')).statusCode).toBe(200);

    // 成功でカウンタが消えるので、以後は再び閾値ぶん試行できる。
    for (let i = 0; i < maxFailures; i += 1) {
      expect((await post(app, 'admin')).statusCode).toBe(401);
    }
  });
});
