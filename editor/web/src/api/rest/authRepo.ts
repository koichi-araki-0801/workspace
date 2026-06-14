import type {
  AuthRepository,
  LoginRequest,
  LoginResult,
  PasswordInitRequest,
  User,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restAuthRepo: AuthRepository = {
  login: (req: LoginRequest) =>
    attemptRest(() => apiFetch<LoginResult>('/auth/login', { method: 'POST', body: req })),

  logout: () => attemptRest(() => apiFetch<void>('/auth/logout', { method: 'POST' })),

  me: () => attemptRest(() => apiFetch<User | null>('/auth/me')),

  initPassword: (req: PasswordInitRequest) =>
    attemptRest(() => apiFetch<void>('/auth/init-password', { method: 'POST', body: req })),
};
