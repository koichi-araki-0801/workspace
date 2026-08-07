// =============================================================================
// auth.loginIdAlphabet.test.ts — 運用アルファベット外のログインID の扱い
// =============================================================================
// DB の照合順序(`Japanese_CI_AS`)はゼロウェイト文字などを無視して等価と見なすが、
// JS の正規形(`canonicalLoginId` = NFKC + 小文字化)はそれらを残す。よって
// `ad<ZWSP>min` は **DB では `admin` と同一行・JS では別キー**になり、1 アカウントに対して
// 無限の失敗カウンタを割り当てられる(= レート制限の実質無効化)。照合順序を JS で
// 再現する道は取らず、運用アルファベットの外側をレート制限の**手前**で断つ。
//
// ここで主張するのは 2 つ:
//   1. 断ったことが応答から判らない — 文言・ステータス・`code`・応答時間が既知 ID の
//      失敗と同一(1 つでも差があればそれ自体が新しいオラクルになる)
//   2. 断った試行は DB へも KDF へも届かず、レート制限の表にキーを 1 つも作らない
//      (作ってしまうなら、断るためだけに表を埋められる)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INVALID_CREDENTIALS_MESSAGE, unauthorized } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-alphabet-'));
process.env.DATA_ROOT = tmp;
process.env.AUTH_REQUIRED = 'true';
const FLOOR_MS = 120;
process.env.AUTH_FAILURE_FLOOR_MS = String(FLOOR_MS);

/** 既知 ID の失敗(= 比較の基準)。実装と同じ文言・kind を返す。 */
const login = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
  throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
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

/**
 * 運用アルファベット外の入力。正規形(NFKC + 小文字化)を通しても ASCII 英数字 + `_` に
 * ならないものを並べる。先頭 2 つが F16 の核心 — DB では `admin` と**同じ行**に当たる。
 */
const OUT_OF_ALPHABET = [
  'ad​min', // ZERO WIDTH SPACE: 照合順序は無視するが NFKC は残す = 同一行・別キー
  'ad﻿min', // ZERO WIDTH NO-BREAK SPACE(同上)
  'admin-1', // ハイフンは運用アルファベット外
  'あどみん', // かな: NFKC でも畳まれない
  'admin@example.com',
  '', // 空(正規形が空になる入力も同じ扱い)
];

describe('運用アルファベット外のログインID', () => {
  let app: FastifyInstance;
  let resetLoginRateLimit: () => void;
  let entryCount: () => number;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { authRoutes } = await import('../src/routes/auth.routes.js');
    const rate = await import('../src/auth/loginRateLimit.js');
    resetLoginRateLimit = rate.resetLoginRateLimit;
    entryCount = rate.loginAttemptEntryCount;
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

  const post = async (username: string): Promise<{ ms: number; status: number; body: unknown }> => {
    const started = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username, password: 'wrong' },
    });
    return { ms: performance.now() - started, status: res.statusCode, body: res.json() };
  };

  it.each(OUT_OF_ALPHABET)('%j は既知 ID の失敗と応答が 1 バイトも違わない', async (username) => {
    resetLoginRateLimit();
    const known = await post('admin');
    resetLoginRateLimit();
    const rejected = await post(username);
    // 文言・ステータス・kind・code(無いこと)まで含めてボディが完全一致すること。
    expect(rejected.status).toBe(known.status);
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual(known.body);
    expect(rejected.body).toEqual({ kind: 'unauthorized', message: INVALID_CREDENTIALS_MESSAGE });
  });

  // 応答時間フロアを飛ばすと「速い = アルファベット外」で見分けられる。既知 ID の失敗と
  // 同じ下限を払うこと(`auth.failureFloor.test.ts` と同じ流儀で丸め分の余裕を見る)。
  it('応答時間も既知 ID の失敗と同じ下限を払う', async () => {
    for (const username of OUT_OF_ALPHABET) {
      resetLoginRateLimit();
      const { ms } = await post(username);
      expect(ms, username).toBeGreaterThanOrEqual(FLOOR_MS - 5);
    }
  });

  // 断つ位置が「レート制限の手前」であることの主張。DB(KDF)へ届かないこと、
  // そして表にキーが 1 つも増えないこと(増えるなら、断るためだけに表を埋められる)。
  it('DB へも KDF へも届かず、レート制限の表にキーを作らない', async () => {
    for (const username of OUT_OF_ALPHABET) await post(username);
    expect(login).not.toHaveBeenCalled();
    expect(entryCount()).toBe(0);
  });

  // 正規化で運用アルファベットへ**入る**入力は今までどおり通す(全角の `ＡＤＭＩＮ` は
  // DB でも `admin` 行に当たるので、断ると正規の利用者を締め出す)。
  it.each([
    ['admin', 'admin'],
    ['ADMIN', 'admin'],
    ['ａｄｍｉｎ', 'admin'],
    ['admin   ', 'admin'],
    ['user_01', 'user_01'],
    // 末尾の BOM は JS の `trimEnd` が空白として落とし、DB も末尾空白を無視する。
    // 正規形が `admin` になる = DB と同じ行を指すので、断つ理由がない。
    ['admin﻿', 'admin'],
  ])('%j は従来どおり資格情報の検証まで進む(正規形 %j)', async (username, canonical) => {
    resetLoginRateLimit();
    login.mockClear();
    await post(username);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0][0]).toBe(canonical);
    expect(entryCount()).toBeGreaterThan(0);
  });
});
