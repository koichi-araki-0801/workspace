// =============================================================================
// auth.loginRateLimit.test.ts — ログインルートの試行回数制限(結合テスト)
// =============================================================================
// `POST /auth/login` は唯一の未認証 KDF 到達点で、無制限だと総当たりも、
// PBKDF2(12 万回反復)を空回しさせる CPU 枯渇も、ここを何度でも通れる。
// 「判定してから通し、失敗を後で数える」形の制限も、同時に投げれば
// 判定を全部素通しできる。資格情報の検証自体は repo の責務なのでモックし、
// 「ルートが何回リポジトリまで通したか」と「拒否後に応答が変わるか」だけを見る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unauthorized } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

// config を import する前に、監査ログの書き出し先を一時ディレクトリへ逃がす。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-login-rate-'));
process.env.DATA_ROOT = tmp;
process.env.AUTH_REQUIRED = 'true';
// 失敗応答のフロア(既定 300ms)はここでは主題でないので切る。フロアそのものは
// 「掛かること」を専用テストで見る。
process.env.AUTH_FAILURE_FLOOR_MS = '0';

// 戻り値を `Promise<unknown>` と明示する: 既定実装は throw のみなので、注釈が無いと
// `never` に推論され、成功系を差し込む `mockImplementationOnce` が型エラーになる。
const login = vi.fn(async (_loginId: string, _password: string): Promise<unknown> => {
  throw unauthorized('ユーザーIDまたはパスワードが違います');
});

vi.mock('../src/repositories/authRepo.js', () => ({
  login: (...args: unknown[]) => login(...(args as [string, string])),
  logout: vi.fn(async () => {}),
  initPassword: vi.fn(async () => {}),
}));

const post = (app: FastifyInstance, username: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { username, password: 'wrong' } });

describe('POST /auth/login のレート制限', () => {
  let app: FastifyInstance;
  let maxFailures: number;
  let maxConcurrent: number;
  let resetLoginRateLimit: () => void;
  let loginInFlightCount: () => number;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { authRoutes } = await import('../src/routes/auth.routes.js');
    const rate = await import('../src/auth/loginRateLimit.js');
    maxFailures = rate.LOGIN_MAX_FAILURES;
    maxConcurrent = rate.MAX_CONCURRENT_ATTEMPTS;
    resetLoginRateLimit = rate.resetLoginRateLimit;
    loginInFlightCount = rate.loginInFlightCount;
    app = Fastify();
    // `authRoutes` の init-password 経路は `requireAuth` → `loadUser` を通り、
    // `request.server.sessionStore` を読む。本番と同じ形にするため載せておく。
    decorateSessionStore(app, createSessionStub());
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

  // ★ 本命。判定と計上が別タイミングだった頃は、同一 tick に到着した N 本がすべて
  // 「まだ 0 回」の状態を読んで全部通過し、N 本ぶんの KDF がスレッドプールへ流れた。
  // 窓あたりの試行が閾値ではなく「攻撃者の同時接続数」になる。
  it('lets a concurrent burst reach the repository only a bounded number of times', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    login.mockImplementation(async () => {
      await gate;
      throw unauthorized('ユーザーIDまたはパスワードが違います');
    });

    const burst = Promise.all(Array.from({ length: 50 }, () => post(app, 'admin')));
    // 全部が preHandler を抜けて宙吊りになるのを待ってから解放する。
    await new Promise((r) => setTimeout(r, 20));
    expect(login.mock.calls.length).toBeLessThanOrEqual(maxConcurrent);
    release();
    const results = await burst;

    expect(login.mock.calls.length).toBeLessThanOrEqual(maxFailures);
    // 通らなかった分は 403(総当たり or 混雑)。KDF まで降ろさずに断っている。
    expect(results.filter((r) => r.statusCode === 403).length).toBeGreaterThanOrEqual(
      50 - maxFailures,
    );
    // ゲージが 0 に戻らないと以後の全ログインが恒久的に拒否される(自己 DoS)。
    expect(loginInFlightCount()).toBe(0);
    login.mockReset();
    login.mockImplementation(async () => {
      throw unauthorized('ユーザーIDまたはパスワードが違います');
    });
  });

  it('does not lock out a different login id from the same IP', async () => {
    for (let i = 0; i < maxFailures; i += 1) await post(app, 'admin');

    const res = await post(app, 'editor');
    expect(res.statusCode).toBe(401);
  });

  // 大小文字・末尾空白・全角で書き分けるだけで別カウンタになると、1 アカウントに対して
  // 独立した閾値をいくつでも作れる(DB 側は同じ 1 行に当たる)。
  it('cannot be split by writing the same login id differently', async () => {
    for (let i = 0; i < maxFailures; i += 1) await post(app, 'admin');

    for (const variant of ['ADMIN', 'admin ', 'ａｄｍｉｎ']) {
      expect((await post(app, variant)).statusCode).toBe(403);
    }
  });

  // 正規形は DB の引数にも渡る。ルートが生の入力をそのまま repo へ流していないこと。
  // 先頭空白は入れない — 照合順序が詰めるのは**末尾**だけなので `  admin` は DB 上も
  // 別の行であり、運用アルファベット外としてルートの手前で断たれる
  // (`auth.loginIdAlphabet.test.ts`)。
  it('passes the canonical login id to the repository', async () => {
    await post(app, 'Admin  ');
    expect(login).toHaveBeenCalledWith('admin', 'wrong');
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
