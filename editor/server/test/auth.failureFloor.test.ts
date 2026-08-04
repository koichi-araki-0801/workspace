// =============================================================================
// auth.failureFloor.test.ts — 認証失敗応答の時間フロア
// =============================================================================
// 未知のログインID は DB 往復だけで返り、実在する ID は DB 往復 + PBKDF2(60ms 前後)を
// 払う。文言とステータスを揃えても、この差だけで「その ID は存在するか」が読める。
// ここで主張するのは「失敗の種類によらず、応答が下限時間を下回らない」こと。
// レート制限による拒否にはフロアを掛けない(攻撃者自身のキーの状態しか反映せず、
// 速く返すほうが同時実行の在庫を空ける)ことも併せて固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unauthorized, validation } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-floor-'));
process.env.DATA_ROOT = tmp;
process.env.AUTH_REQUIRED = 'true';
const FLOOR_MS = 120;
process.env.AUTH_FAILURE_FLOOR_MS = String(FLOOR_MS);

const login = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
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

describe('失敗応答の時間フロア', () => {
  let app: FastifyInstance;
  let resetLoginRateLimit: () => void;
  let maxFailures: number;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { authRoutes } = await import('../src/routes/auth.routes.js');
    const rate = await import('../src/auth/loginRateLimit.js');
    resetLoginRateLimit = rate.resetLoginRateLimit;
    maxFailures = rate.LOGIN_MAX_FAILURES;
    app = Fastify();
    app.setErrorHandler(errorHandler);
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

  const timedPost = async (username: string): Promise<{ ms: number; status: number }> => {
    const started = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username, password: 'wrong' },
    });
    return { ms: performance.now() - started, status: res.statusCode };
  };

  // 未知 ID(即返り)・パスワード誤り(KDF あり)・DB 障害 のいずれも同じ下限を払う。
  // DB 障害だけ速いと「DB に到達したか」が別のオラクルになる。
  it('takes at least the floor for every failing outcome', async () => {
    const cases: Array<[string, () => void]> = [
      ['未知 ID(即返り)', () => login.mockRejectedValueOnce(unauthorized('だめ'))],
      [
        'KDF を回した誤り',
        () =>
          login.mockImplementationOnce(async () => {
            await new Promise((r) => setTimeout(r, 30));
            throw unauthorized('だめ');
          }),
      ],
      ['DB 障害', () => login.mockRejectedValueOnce(new Error('ECONNREFUSED'))],
      ['入力検証の失敗', () => login.mockRejectedValueOnce(validation('だめ'))],
    ];
    for (const [label, setup] of cases) {
      resetLoginRateLimit();
      setup();
      const { ms } = await timedPost('admin');
      // タイマーの丸めで数 ms 手前に着地しうるので、わずかな余裕を見る。
      expect(ms, label).toBeGreaterThanOrEqual(FLOOR_MS - 5);
    }
  });

  it('does not pay the floor when the rate limiter refuses the attempt', async () => {
    for (let i = 0; i < maxFailures; i += 1) await timedPost('admin');
    const { ms, status } = await timedPost('admin');
    expect(status).toBe(403);
    expect(ms).toBeLessThan(FLOOR_MS);
  });

  it('does not delay a successful login', async () => {
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
    const { ms, status } = await timedPost('admin');
    expect(status).toBe(200);
    expect(ms).toBeLessThan(FLOOR_MS);
  });
});
