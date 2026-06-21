// =============================================================================
// AuthRepository.ts — 認証・セッション集約のリポジトリ契約
// =============================================================================
import type { LoginRequest, LoginResult, PasswordInitRequest, User } from '../index.js';
import type { Result } from '../result.js';

/** 認証・セッション集約。`web` の local 実装と `server` の REST 実装が共に満たす契約。 */
export interface AuthRepository {
  login(req: LoginRequest): Promise<Result<LoginResult>>;
  logout(): Promise<Result<void>>;
  me(): Promise<Result<User | null>>;
  initPassword(req: PasswordInitRequest): Promise<Result<void>>;
}
