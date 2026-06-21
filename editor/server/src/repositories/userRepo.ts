// =============================================================================
// userRepo.ts — ユーザ集約のサーバ(REST)実装(管理画面)
// =============================================================================
// ハッシュ列は `一覧` / `作成` / `更新` の各操作で一切 select しないため、クライアントへ
// 届くことはない。新規ユーザ / リセットの初期パスワードは `ログインID`(ユーザID)と同一で、
// 初回ログイン時に変更を強制する(sproc が `要パスワード変更`=1 を立てる)。
import { randomUUID } from 'node:crypto';
import { notFound, type User, type UserRole } from '@editor/shared';
import { hashPassword } from '../auth/password.js';
import { asBool, asString, callSproc, firstRow, p } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';

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

export async function listUsers(): Promise<User[]> {
  const rows = await callSproc(SP.user, '一覧');
  return rows.map(rowToUser);
}

export async function createUser(input: Omit<User, 'id'>): Promise<User> {
  const id = randomUUID();
  // 初期パスワードは ログインID(ユーザID) と同一。初回ログインで変更を強制する。
  const { hash, salt, iterations } = hashPassword(input.username);
  const row = firstRow(
    await callSproc(SP.user, '作成', [
      p('公開ID', id),
      p('ログインID', input.username),
      p('表示名', input.displayName),
      p('ロール', input.role),
      p('無効', input.disabled ? 1 : 0),
      p('要パスワード変更', input.mustChangePassword ? 1 : 0),
      p('PWハッシュ', hash),
      p('PWソルト', salt),
      p('PW反復回数', iterations),
    ]),
  );
  if (!row) throw notFound('作成したユーザーを取得できません');
  return rowToUser(row);
}

export async function updateUser(id: string, patch: Partial<Omit<User, 'id'>>): Promise<User> {
  const bit = (b: boolean | undefined) => (b == null ? null : b ? 1 : 0);
  const row = firstRow(
    await callSproc(SP.user, '更新', [
      p('公開ID', id),
      p('表示名', patch.displayName),
      p('ロール', patch.role),
      p('無効', bit(patch.disabled)),
      p('要パスワード変更', bit(patch.mustChangePassword)),
    ]),
  );
  if (!row) throw notFound(`ユーザーが見つかりません: ${id}`);
  return rowToUser(row);
}

export async function resetUserPassword(id: string): Promise<void> {
  // リセット先も初期パスワード = ログインID。公開IDしか持たないので一覧から引く。
  const user = (await listUsers()).find((u) => u.id === id);
  if (!user) throw notFound(`ユーザーが見つかりません: ${id}`);
  const { hash, salt, iterations } = hashPassword(user.username);
  await callSproc(SP.user, 'PWリセット', [
    p('公開ID', id),
    p('PWハッシュ', hash),
    p('PWソルト', salt),
    p('PW反復回数', iterations),
  ]);
}
