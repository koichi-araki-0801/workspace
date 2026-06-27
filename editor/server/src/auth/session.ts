// =============================================================================
// session.ts — セッションのライフサイクル(フェーズ2)
// =============================================================================
// セッションは DB に置く(クッキー `editor.sid` はランダム id だけを保持)ので、
// サーバ再起動でも全員がログアウトしない。クッキーは HttpOnly でクライアント JS
// からは触れない。
import { randomBytes } from 'node:crypto';
import type { User } from '@editor/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { config } from '../config.js';
import { callSproc, firstRow, p } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';
import { rowToUser } from '../repositories/userRepo.js';

const TTL_MS = config.auth.sessionTtlHours * 3_600_000;

/**
 * セッションクッキーのオプション(`reply.setCookie` 経由の Set-Cookie)。
 * 注意: `@fastify/cookie` の `maxAge` は**秒**単位(Express `res.cookie` のミリ秒ではない)。
 * TTL はミリ秒で持っているため、ここで秒へ換算する。
 */
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.auth.cookieSecure,
  maxAge: Math.floor(TTL_MS / 1000),
  path: '/',
} satisfies CookieSerializeOptions;

export async function createSession(loginId: string): Promise<string> {
  const id = randomBytes(32).toString('hex');
  await callSproc(SP.session, '作成', [
    p('セッションID', id),
    p('ログインID', loginId),
    p('有効期限', new Date(Date.now() + TTL_MS)),
  ]);
  return id;
}

/** 有効(未期限切れ・未失効)なセッションに紐づくユーザー、無ければ null。 */
export async function getSessionUser(sessionId: string): Promise<User | null> {
  const row = firstRow(await callSproc(SP.session, '取得', [p('セッションID', sessionId)]));
  return row ? rowToUser(row) : null;
}

export async function destroySession(sessionId: string): Promise<void> {
  await callSproc(SP.session, '失効', [p('セッションID', sessionId)]);
}

/**
 * 生存中の全セッションを失効させる。サーバ起動フックで呼び、再起動をまたいだ旧
 * セッション(DB は再起動耐性なので残る)を無効化して全員に再ログインを強制する。
 */
export async function invalidateAllSessions(): Promise<void> {
  await callSproc(SP.session, '全失効', []);
}

/** リクエストの Cookie ヘッダを name→value マップへ解析する(cookie-parser 依存なし)。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** リクエストのクッキーヘッダからセッション id を読み取る。 */
export function sessionIdFrom(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[config.auth.cookieName];
}
