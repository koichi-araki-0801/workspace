/**
 * User domain rules — pure, Vue/DI-free so they unit-test in isolation and are
 * reusable on the server.
 */
import type { User } from '../index.js';

/** True when the user exists and has the admin role. */
export function isAdmin(user: User | null | undefined): boolean {
  return user?.role === 'admin';
}

/** Fields collected when creating a user. */
export interface NewUserForm {
  username: string;
  displayName: string;
}

/** Per-field validation messages (empty object = valid). */
export interface NewUserErrors {
  username?: string;
  displayName?: string;
}

/** ユーザーIDの許容文字: 半角英数字とアンダースコア。 */
const USERNAME_PATTERN = /^[a-z0-9_]+$/i;

/**
 * Validates the add-user form. Pass `existingUsernames` to reject duplicates
 * (case-insensitive); omit it to skip the uniqueness check.
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
