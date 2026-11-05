// =============================================================================
// userRow.ts — `ユーザー` 系の結果列を `User` へ写す
// =============================================================================
// ユーザー sproc の `一覧`・`認証情報取得` とセッション sproc の `取得` は、同じ結果列
// (公開ID・ログインID・表示名・ロール・無効・要パスワード変更)を返す。読み方をここ 1 つに
// 集め、`userRepo.ts`・`authRepo.ts`・`sessionRepo.ts` が共有する。
import type { User, UserRole } from '@editor/shared';
import { asBool, asString } from '../db/sproc.js';

export function rowToUser(r: Record<string, unknown>): User {
  return {
    id: asString(r.公開ID),
    username: asString(r.ログインID),
    displayName: asString(r.表示名),
    role: asString(r.ロール) as UserRole,
    disabled: asBool(r.無効),
    mustChangePassword: asBool(r.要パスワード変更),
  };
}
