import {
  type AuthRepository,
  type LoginRequest,
  type PasswordInitRequest,
  type User,
  unauthorized,
  validation,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, listUsersSync, passwordFor, read, write } from './store';

export const localAuthRepo: AuthRepository = {
  login: (req: LoginRequest) =>
    attempt(() => {
      const user = listUsersSync().find((u) => u.username === req.username);
      // Don't reveal whether the id exists: same message for unknown user / wrong password.
      if (!user) throw unauthorized('ユーザーIDまたはパスワードが違います');
      if (user.disabled) throw unauthorized('このアカウントは無効化されています');
      if (passwordFor(req.username) !== req.password)
        throw unauthorized('ユーザーIDまたはパスワードが違います');
      write(K.session, user.id);
      return delay({ user, mustChangePassword: user.mustChangePassword });
    }),

  logout: () =>
    attempt(() => {
      localStorage.removeItem(K.session);
      return delay(undefined);
    }),

  me: () => attempt(() => delay(currentUser())),

  initPassword: (req: PasswordInitRequest) =>
    attempt(() => {
      const user = listUsersSync().find((u) => u.username === req.username);
      if (!user) throw unauthorized('ユーザーIDが見つかりません');
      if (user.disabled) throw unauthorized('このアカウントは無効化されています');
      if (req.newPassword.length < 4) throw validation('新しいパスワードが短すぎます');
      const pw = read<Record<string, string>>(K.passwords, {});
      pw[req.username] = req.newPassword;
      write(K.passwords, pw);
      const overrides = read<Record<string, Partial<User>>>(K.userOverride, {});
      overrides[user.id] = { ...overrides[user.id], mustChangePassword: false };
      write(K.userOverride, overrides);
      return delay(undefined);
    }),
};
