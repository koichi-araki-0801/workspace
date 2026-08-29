// =============================================================================
// UserRepository.ts — ユーザー管理集約 (管理画面)
// =============================================================================
// 作成 / リセットは初期資格情報を**払い出す**操作なので、戻り値に一時パスワードの平文を
// 載せる。実装(local / rest)はこれを保存してはならず、呼び出した管理画面がその場で
// 1 回だけ表示する。初期パスワードをログインID と同じにする設計へは戻さない
// (ID を知る者なら誰でも未活性アカウントへ入れる。詳細は `docs/editor/src/設計正典.md`)。
import type { CreatedUser, PasswordResetResult, User } from '../index.js';
import type { Result } from '../result.js';

/** ユーザー管理集約 (管理画面)。 */
export interface UserRepository {
  listUsers(): Promise<Result<User[]>>;
  createUser(user: Omit<User, 'id'>): Promise<Result<CreatedUser>>;
  updateUser(id: string, patch: Partial<Omit<User, 'id'>>): Promise<Result<User>>;
  resetUserPassword(id: string): Promise<Result<PasswordResetResult>>;
}
