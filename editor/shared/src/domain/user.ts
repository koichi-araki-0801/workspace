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

export function validateNewUser(form: NewUserForm): NewUserErrors {
  const errors: NewUserErrors = {};
  if (!form.username.trim()) errors.username = 'ユーザーIDを入力してください';
  if (!form.displayName.trim()) errors.displayName = '表示名を入力してください';
  return errors;
}

export function hasErrors(errors: NewUserErrors): boolean {
  return Object.values(errors).some(Boolean);
}
