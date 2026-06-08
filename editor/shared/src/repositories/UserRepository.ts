import type { User } from '../index.js';
import type { Result } from '../result.js';

/** User-management aggregate (admin screen). */
export interface UserRepository {
  listUsers(): Promise<Result<User[]>>;
  createUser(user: Omit<User, 'id'>): Promise<Result<User>>;
  updateUser(id: string, patch: Partial<Omit<User, 'id'>>): Promise<Result<User>>;
  resetUserPassword(id: string): Promise<Result<void>>;
}
