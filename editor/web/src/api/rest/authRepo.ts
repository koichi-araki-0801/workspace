// =============================================================================
// authRepo.ts — 認証の REST 実装(/auth/* エンドポイントへの委譲)
// =============================================================================
import {
  type AuthRepository,
  apiPaths,
  type LoginRequest,
  type LoginResult,
  type PasswordInitRequest,
  type User,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restAuthRepo: AuthRepository = {
  login: (req: LoginRequest) =>
    attemptRest(() => apiFetch<LoginResult>(apiPaths.authLogin, { method: 'POST', body: req })),

  logout: () => attemptRest(() => apiFetch<void>(apiPaths.authLogout, { method: 'POST' })),

  me: () => attemptRest(() => apiFetch<User | null>(apiPaths.authMe)),

  initPassword: (req: PasswordInitRequest) =>
    attemptRest(() => apiFetch<void>(apiPaths.authInitPassword, { method: 'POST', body: req })),
};
