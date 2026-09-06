// =============================================================================
// sessionStub.ts — テストが載せるセッションストア
// =============================================================================
// 本番は `buildApp` が `app.decorate('sessionStore', …)` で載せ、`loadUser` は
// `request.server.sessionStore` から読む。テストは自前の Fastify を組むので、同じ名前で
// 最小のストアを載せる。手製 request でガードを直接呼ぶ場合は `withSessionStore` で
// `request.server` を作る。
import type { User } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { SessionStore } from '../../src/auth/session.js';

export interface SessionStubOptions {
  /** セッション id → ユーザー。null / 未指定は未ログイン扱い。 */
  getSessionUser?: (sessionId: string) => Promise<User | null> | User | null;
}

export function createSessionStub(opts: SessionStubOptions = {}): SessionStore {
  return {
    createSession: async () => 'sid',
    destroySession: async () => {},
    invalidateAllSessions: async () => {},
    purgeExpiredSessions: async () => {},
    getSessionUser: async (sessionId) => (await opts.getSessionUser?.(sessionId)) ?? null,
  };
}

/** 本番と同じ名前でインスタンスへ載せる。 */
export function decorateSessionStore(app: FastifyInstance, store: SessionStore): void {
  app.decorate('sessionStore', store);
}

/** 手製 request にストアを載せる(`request.server.sessionStore` の最小形)。 */
export function withSessionStore<T extends object>(request: T, store: SessionStore): T {
  return Object.assign(request, { server: { sessionStore: store } });
}
