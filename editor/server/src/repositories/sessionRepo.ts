// =============================================================================
// sessionRepo.ts — セッション sproc の窓口
// =============================================================================
// セッション sproc の 5 操作を 1 対 1 に包む。id の生成と有効期限の計算は
// `auth/session.ts` の役目で、ここは受け取った値をそのまま sproc へ渡すだけにする。
import type { User } from '@editor/shared';
import { firstRow, p, type SprocClient } from '../db/sproc.js';
import { OP, SP } from '../db/sprocNames.js';
import { rowToUser } from './userRow.js';

export interface SessionRepo {
  insertSession(sessionId: string, loginId: string, expiresAt: Date): Promise<void>;
  /** 有効(未期限切れ・未失効)なセッションのユーザー。sproc が 0 行を返したら null。 */
  findSessionUser(sessionId: string): Promise<User | null>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllSessions(): Promise<void>;
  purgeSessions(retentionDays: number): Promise<void>;
}

export function createSessionRepo(sproc: SprocClient): SessionRepo {
  return {
    async insertSession(sessionId, loginId, expiresAt) {
      await sproc.callSproc(SP.session, OP.session.create, [
        p('セッションID', sessionId),
        p('ログインID', loginId),
        p('有効期限', expiresAt),
      ]);
    },

    async findSessionUser(sessionId) {
      const row = firstRow(
        await sproc.callSproc(SP.session, OP.session.get, [p('セッションID', sessionId)]),
      );
      return row ? rowToUser(row) : null;
    },

    async revokeSession(sessionId) {
      await sproc.callSproc(SP.session, OP.session.revoke, [p('セッションID', sessionId)]);
    },

    async revokeAllSessions() {
      await sproc.callSproc(SP.session, OP.session.revokeAll, []);
    },

    async purgeSessions(retentionDays) {
      await sproc.callSproc(SP.session, OP.session.purge, [p('保持日数', retentionDays)]);
    },
  };
}
