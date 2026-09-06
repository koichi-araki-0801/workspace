// =============================================================================
// session.ts — セッションのライフサイクル
// =============================================================================
// セッションは DB に置く(クッキー `editor.sid` はランダム id だけを保持)ので、
// サーバ再起動でも全員がログアウトしない。クッキーは HttpOnly でクライアント JS
// からは触れない。
import { randomBytes } from 'node:crypto';
import type { User } from '@editor/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { config } from '../config.js';
import { firstRow, p, realSproc, type SprocClient } from '../db/sproc.js';
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

/**
 * セッションのライフサイクル。実体は DB で、`buildApp` が組み立てて
 * `app.decorate('sessionStore', …)` でインスタンスへ載せる。`middleware/auth.ts` の
 * `loadUser` は `request.server.sessionStore` から読む — ガード関数
 * (`requireAuth` 等)は `routes/routeGuards.ts` の `levelOf` が `preHandlers.includes()`
 * で参照同一性を見るため、クロージャ化・ファクトリ化できない。
 */
export interface SessionStore {
  createSession(loginId: string): Promise<string>;
  getSessionUser(sessionId: string): Promise<User | null>;
  destroySession(sessionId: string): Promise<void>;
  invalidateAllSessions(): Promise<void>;
  purgeExpiredSessions(retentionDays?: number): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `buildApp` が載せるセッションストア。ガードはここから読む。 */
    sessionStore: SessionStore;
  }
}

export function createSessionStore(sproc: SprocClient): SessionStore {
  return {
    async createSession(loginId: string): Promise<string> {
      const id = randomBytes(32).toString('hex');
      await sproc.callSproc(SP.session, '作成', [
        p('セッションID', id),
        p('ログインID', loginId),
        p('有効期限', new Date(Date.now() + TTL_MS)),
      ]);
      return id;
    },

    /** 有効(未期限切れ・未失効)なセッションに紐づくユーザー、無ければ null。 */
    async getSessionUser(sessionId: string): Promise<User | null> {
      const row = firstRow(
        await sproc.callSproc(SP.session, '取得', [p('セッションID', sessionId)]),
      );
      return row ? rowToUser(row) : null;
    },

    async destroySession(sessionId: string): Promise<void> {
      await sproc.callSproc(SP.session, '失効', [p('セッションID', sessionId)]);
    },

    /**
     * 生存中の全セッションを失効させる。サーバ起動フックで呼び、再起動をまたいだ旧
     * セッション(DB は再起動耐性なので残る)を無効化して全員に再ログインを強制する。
     */
    async invalidateAllSessions(): Promise<void> {
      await sproc.callSproc(SP.session, '全失効', []);
    },

    /**
     * 期限切れ・失効済みのセッション行を物理削除する。`失効` / `全失効` は論理フラグを
     * 立てるだけなので、放置すると行はログインのたびに単調増加する。起動時と定期実行で回す。
     * 削除の境界は「有効期限が保持日数ぶん過去」— `有効期限 < now` にすると、期限内の
     * 行まで巻き込む書き方に一歩で退行しうる(全員が突然ログアウトする可用性事故)。
     */
    async purgeExpiredSessions(retentionDays = 7): Promise<void> {
      await sproc.callSproc(SP.session, '掃除', [p('保持日数', retentionDays)]);
    },
  };
}

/**
 * 注入をまだ受けていない呼び出し元(`repositories/authRepo.ts`)のための既定ストアと別名。
 * 呼び出し元が注入を受け取る形になった時点で削除する。
 */
const defaultStore = createSessionStore(realSproc);
export const createSession = defaultStore.createSession;
export const destroySession = defaultStore.destroySession;

/** セッション id の形。`randomBytes(32).toString('hex')` = 64 桁の小文字 hex に限る。 */
const SESSION_ID_RE = /^[0-9a-f]{64}$/;

/**
 * リクエストのクッキーヘッダからセッション id を読み取る。
 *
 * Cookie ヘッダの**全**エントリへ `decodeURIComponent` を try/catch 無しで掛けると、
 * `x=%` のような壊れた値が 1 個混ざるだけで URIError が飛び、editor と無関係な
 * cookie でも全 API が 500 になる(401 ですらない)。セッション id は hex なので
 * パーセントエスケープを解く必要が最初から無く、**目的の名前だけを取り出して decode
 * しない**形にすれば経路ごと消える。
 *
 * 形が合わない値は DB 往復の前に捨てる。ゴミ id での sproc 呼び出しを無くすと同時に、
 * 「解析できる cookie / できない cookie」で挙動が割れる面も無くなる。
 */
export function sessionIdFrom(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const name = config.auth.cookieName;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return SESSION_ID_RE.test(value) ? value : undefined;
  }
  return undefined;
}
