// =============================================================================
// user.ts — ユーザードメインのルール (純粋・Vue/DI 非依存で単体テスト可能)
// =============================================================================
import type { User } from '../index.js';

/** ユーザーが存在し、かつ admin ロールを持つとき true。 */
export function isAdmin(user: User | null | undefined): boolean {
  return user?.role === 'admin';
}

/** ユーザー作成時に集める入力フィールド。 */
export interface NewUserForm {
  username: string;
  displayName: string;
}

/** フィールド別のバリデーションメッセージ (空オブジェクト = 妥当)。 */
export interface NewUserErrors {
  username?: string;
  displayName?: string;
}

/** ユーザーIDの許容文字: 半角英数字とアンダースコア。 */
const USERNAME_PATTERN = /^[a-z0-9_]+$/i;

/**
 * ユーザー追加フォームを検証する。`existingUsernames` を渡すと重複 (大文字小文字
 * 無視) を弾く。省略すると一意性チェックをスキップする。
 */
export function validateNewUser(
  form: NewUserForm,
  existingUsernames: readonly string[] = [],
): NewUserErrors {
  const errors: NewUserErrors = {};
  const username = form.username.trim();
  if (!username) errors.username = 'ユーザーIDを入力してください';
  else if (!USERNAME_PATTERN.test(username))
    errors.username = '半角英数字とアンダースコアのみ使用できます';
  else if (existingUsernames.some((u) => u.toLowerCase() === username.toLowerCase()))
    errors.username = 'このユーザーIDは既に使われています';
  if (!form.displayName.trim()) errors.displayName = '表示名を入力してください';
  return errors;
}

export function hasErrors(errors: NewUserErrors): boolean {
  return Object.values(errors).some(Boolean);
}
