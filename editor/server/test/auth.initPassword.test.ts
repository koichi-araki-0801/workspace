// =============================================================================
// auth.initPassword.test.ts — パスワード変更ルートの施錠(認証 + 本人限定)の結合テスト
// =============================================================================
// `POST /auth/init-password` は以前セッションも所有証明も要求せず、`{"username":"admin",...}`
// を投げるだけで任意アカウントを乗っ取れた。ここで守るのは前段(セッション必須・宛先は
// セッション所有者に固定・試行回数の制限)で、現行パスワードの検証自体は repo 側
// (`authRepo.initPassword`)の責務なのでモックして「ルートがどこまで通したか」だけを見る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// config を import する前に、監査ログの書き出し先を一時ディレクトリへ逃がす。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-auth-routes-'));
process.env.DATA_ROOT = tmp;
process.env.AUTH_REQUIRED = 'true';
process.env.AUTH_FAILURE_FLOOR_MS = '0';

const initPassword = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../src/repositories/authRepo.js', () => ({
  login: vi.fn(),
  logout: vi.fn(async () => {}),
  initPassword: (...args: unknown[]) => initPassword(...(args as [])),
}));

// セッションは cookie `editor.sid=<username>` を「その名前のユーザ」とみなす最小の偽装にする。
vi.mock('../src/auth/session.js', () => ({
  cookieOptions: {},
  createSession: vi.fn(async () => 'sid'),
  destroySession: vi.fn(async () => {}),
  sessionIdFrom: (cookie?: string) => cookie?.match(/editor\.sid=([^;]+)/)?.[1],
  getSessionUser: async (sid: string) =>
    sid
      ? {
          id: sid,
          username: sid,
          displayName: sid,
          role: 'editor',
          disabled: false,
          // `must:` 前置きのセッションは「初期パスワードのまま」= `requireAuth` が他経路を
          // 止める状態。パスワード変更だけは通らないと復旧不能になるのでここで確かめる。
          mustChangePassword: sid.startsWith('must:'),
        }
      : null,
}));

const BODY = { currentPassword: 'current-pw', newPassword: 'new-password' };

describe('POST /auth/init-password の施錠', () => {
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
    app.decorateRequest('user', undefined);
    app.setErrorHandler(errorHandler);
    await app.register(authRoutes);
    await app.ready();
  });

  beforeEach(() => {
    resetLoginRateLimit();
    initPassword.mockClear();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects an unauthenticated request (401) and never reaches the repository', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/init-password',
      payload: { username: 'admin', ...BODY },
    });
    expect(res.statusCode).toBe(401);
    expect(initPassword).not.toHaveBeenCalled();
  });

  it('forbids changing another account (403) even with a valid session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/init-password',
      headers: { cookie: 'editor.sid=editor' },
      payload: { username: 'admin', ...BODY },
    });
    expect(res.statusCode).toBe(403);
    expect(initPassword).not.toHaveBeenCalled();
  });

  // ★ 宛先は body ではなくセッション所有者から導出する。比較で守っている限り、比較の
  // 条件式が壊れれば穴に戻る(実際それが 2026-08-03 の姿だった)。body の値が宛先として
  // 使われていないことを、「表記が違っても渡るのは正規化済みのセッション所有者」で示す。
  it('targets the session owner, not the username in the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/init-password',
      headers: { cookie: 'editor.sid=editor' },
      payload: { username: 'EDITOR  ', ...BODY },
    });
    expect(res.statusCode).toBe(204);
    expect(initPassword).toHaveBeenCalledWith(
      'editor',
      { username: 'EDITOR  ', ...BODY },
      'editor',
    );
  });

  it('accepts the session owner changing their own password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/init-password',
      headers: { cookie: 'editor.sid=editor' },
      payload: { username: 'editor', ...BODY },
    });
    expect(res.statusCode).toBe(204);
    expect(initPassword).toHaveBeenCalledTimes(1);
  });

  it('still lets a must-change-password session change its own password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/init-password',
      headers: { cookie: 'editor.sid=must:editor' },
      payload: { username: 'must:editor', ...BODY },
    });
    expect(res.statusCode).toBe(204);
    expect(initPassword).toHaveBeenCalledTimes(1);
  });

  it('rejects a body without the current password (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/init-password',
      headers: { cookie: 'editor.sid=editor' },
      payload: { username: 'editor', newPassword: 'new-password' },
    });
    expect(res.statusCode).toBe(400);
    expect(initPassword).not.toHaveBeenCalled();
  });

  // 認証済みなら 1 リクエストで KDF 2 回(現行 PW の検証 + 新 PW のハッシュ)を引ける。
  // login と同じ制限を通していないと、ここが無制限の CPU 消費口として残る。
  it('applies the credential rate limit to init-password too', async () => {
    initPassword.mockImplementation(async () => {
      throw Object.assign(new Error('bad'), { kind: 'unauthorized' });
    });
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/auth/init-password',
        headers: { cookie: 'editor.sid=editor' },
        payload: { username: 'editor', ...BODY },
      });
    for (let i = 0; i < maxFailures; i += 1) await send();
    initPassword.mockClear();

    const res = await send();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'LOGIN_RATE_LIMITED' });
    expect(initPassword).not.toHaveBeenCalled();
    initPassword.mockReset();
    initPassword.mockImplementation(async () => {});
  });
});
