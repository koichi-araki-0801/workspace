// =============================================================================
// userRepo.ts — ユーザー管理の REST 実装(一覧/作成/更新/PW リセット)
// =============================================================================
import type { User, UserRepository } from '@editor/shared';
import { apiFetch, attemptRest } from './http';

const enc = encodeURIComponent;

export const restUserRepo: UserRepository = {
  listUsers: () => attemptRest(() => apiFetch<User[]>('/users')),

  createUser: (user: Omit<User, 'id'>) =>
    attemptRest(() => apiFetch<User>('/users', { method: 'POST', body: user })),

  updateUser: (id: string, patch: Partial<Omit<User, 'id'>>) =>
    attemptRest(() => apiFetch<User>(`/users/${enc(id)}`, { method: 'PATCH', body: patch })),

  resetUserPassword: (id: string) =>
    attemptRest(() => apiFetch<void>(`/users/${enc(id)}/reset-password`, { method: 'POST' })),
};
