// =============================================================================
// userRepo.ts — ユーザー管理の REST 実装(一覧/作成/更新/PW リセット)
// =============================================================================
import { apiPaths, buildPath, type User, type UserRepository } from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restUserRepo: UserRepository = {
  listUsers: () => attemptRest(() => apiFetch<User[]>(apiPaths.users)),

  createUser: (user: Omit<User, 'id'>) =>
    attemptRest(() => apiFetch<User>(apiPaths.users, { method: 'POST', body: user })),

  updateUser: (id: string, patch: Partial<Omit<User, 'id'>>) =>
    attemptRest(() =>
      apiFetch<User>(buildPath(apiPaths.userById, { id }), { method: 'PATCH', body: patch }),
    ),

  resetUserPassword: (id: string) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.userResetPassword, { id }), { method: 'POST' }),
    ),
};
