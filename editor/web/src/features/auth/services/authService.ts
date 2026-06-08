import type { AuthRepository, LoginResult, Result, User } from '@editor/shared';
import { useAuthRepo } from '@/api/repositories';

/**
 * Authentication use-cases. A thin service over {@link AuthRepository} (it adds
 * no business rules today, but is the seam where they'd live and keeps the store
 * off the repository per the Pinia rules). Pure factory — inject the repo so it
 * tests without Vue.
 */
export interface AuthService {
  login(username: string, password: string): Promise<Result<LoginResult>>;
  logout(): Promise<Result<void>>;
  me(): Promise<Result<User | null>>;
  initPassword(username: string, newPassword: string): Promise<Result<void>>;
}

export function createAuthService(repo: AuthRepository): AuthService {
  return {
    login: (username, password) => repo.login({ username, password }),
    logout: () => repo.logout(),
    me: () => repo.me(),
    initPassword: (username, newPassword) => repo.initPassword({ username, newPassword }),
  };
}

/** Wire the service with the injected repository (call in setup). */
export const useAuthService = (): AuthService => createAuthService(useAuthRepo());
