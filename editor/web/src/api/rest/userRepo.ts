// =============================================================================
// userRepo.ts — ユーザー管理の REST 実装(一覧/作成/更新/PW リセット)
// =============================================================================
// 作成 / リセットの応答には一時パスワードの平文が載る。画面に 1 回だけ出すための値なので、
// localStorage やログへ落とさないこと(サーバ側も保存していない = 再取得できない)。
import {
  apiPaths,
  buildPath,
  type CreatedUser,
  type PasswordResetResult,
  type User,
  type UserRepository,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restUserRepo: UserRepository = {
  listUsers: () => attemptRest(() => apiFetch<User[]>(apiPaths.users)),

  createUser: (user: Omit<User, 'id'>) =>
    attemptRest(() => apiFetch<CreatedUser>(apiPaths.users, { method: 'POST', body: user })),

  updateUser: (id: string, patch: Partial<Omit<User, 'id'>>) =>
    attemptRest(() =>
      apiFetch<User>(buildPath(apiPaths.userById, { id }), { method: 'PATCH', body: patch }),
    ),

  resetUserPassword: (id: string) =>
    attemptRest(() =>
      apiFetch<PasswordResetResult>(buildPath(apiPaths.userResetPassword, { id }), {
        method: 'POST',
      }),
    ),
};
