// =============================================================================
// authService.ts — 認証ユースケース(AuthRepository への薄いサービス)
// =============================================================================
import type { AuthRepository, LoginResult, Result, User } from '@editor/shared';
import { useAuthRepo } from '@/api/repositories';

/**
 * 認証ユースケース。`AuthRepository` への薄いサービス(現状は business rule を
 * 持たないが、追加するならここが境界。Pinia ルールに従い store を repository から
 * 切り離す)。純粋な factory — repo を注入することで Vue なしでテストできる。
 */
interface AuthService {
  login(username: string, password: string): Promise<Result<LoginResult>>;
  logout(): Promise<Result<void>>;
  me(): Promise<Result<User | null>>;
  initPassword(username: string, newPassword: string): Promise<Result<void>>;
}

function createAuthService(repo: AuthRepository): AuthService {
  return {
    login: (username, password) => repo.login({ username, password }),
    logout: () => repo.logout(),
    me: () => repo.me(),
    initPassword: (username, newPassword) => repo.initPassword({ username, newPassword }),
  };
}

/** 注入された repository とサービスを結線する(setup 内で呼ぶ)。 */
export const useAuthService = (): AuthService => createAuthService(useAuthRepo());
