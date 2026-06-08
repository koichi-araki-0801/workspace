import type { LoginRequest, LoginResult, PasswordInitRequest, User } from '../index.js';
import type { Result } from '../result.js';

/** Authentication & session aggregate. */
export interface AuthRepository {
  login(req: LoginRequest): Promise<Result<LoginResult>>;
  logout(): Promise<Result<void>>;
  me(): Promise<Result<User | null>>;
  initPassword(req: PasswordInitRequest): Promise<Result<void>>;
}
