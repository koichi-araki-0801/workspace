import type { Result, User, UserRepository, UserRole } from '@editor/shared';
import { useUserRepo } from '@/api/repositories';

export interface NewUserInput {
  username: string;
  displayName: string;
  role: UserRole;
}

/** User-management use-cases for the admin screen. */
export interface UserService {
  list(): Promise<Result<User[]>>;
  /** Create a user with a temporary password (must be reset on first login). */
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
