// =============================================================================
// userService.ts — ユーザー管理画面のユースケース(UserRepository への薄いサービス)
// =============================================================================
import type { Result, User, UserRepository, UserRole } from '@editor/shared';
import { useUserRepo } from '@/api/repositories';

export interface NewUserInput {
  username: string;
  displayName: string;
  role: UserRole;
}

/** admin 画面向けのユーザー管理ユースケース。 */
export interface UserService {
  list(): Promise<Result<User[]>>;
  /** 仮パスワードでユーザーを作成する(初回ログイン時に再設定が必須)。 */
  add(input: NewUserInput): Promise<Result<User>>;
  setDisabled(id: string, disabled: boolean): Promise<Result<User>>;
  resetPassword(id: string): Promise<Result<void>>;
}

export function createUserService(repo: UserRepository): UserService {
  return {
    list: () => repo.listUsers(),
    add: (input) => repo.createUser({ ...input, disabled: false, mustChangePassword: true }),
    setDisabled: (id, disabled) => repo.updateUser(id, { disabled }),
    resetPassword: (id) => repo.resetUserPassword(id),
  };
}

export const useUserService = (): UserService => createUserService(useUserRepo());
