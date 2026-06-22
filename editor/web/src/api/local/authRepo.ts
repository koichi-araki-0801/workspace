// =============================================================================
// authRepo.ts — 認証の local 実装(fixtures + localStorage によるログイン/PW)
// =============================================================================
import {
  type AuthRepository,
  type LoginRequest,
  type PasswordInitRequest,
  type User,
  unauthorized,
  validation,
} from '@editor/shared';
import { currentAppEpoch } from '@/lib/appEpoch';
import { attempt } from './attempt';
import { currentUser, delay, K, listUsersSync, passwordFor, read, write } from './store';

export const localAuthRepo: AuthRepository = {
  login: (req: LoginRequest) =>
    attempt(() => {
      const user = listUsersSync().find((u) => u.username === req.username);
      // ID の存在有無を漏らさない: 未知ユーザーとパスワード誤りで同一メッセージにする。
      if (!user) throw unauthorized('ユーザーIDまたはパスワードが違います');
      if (user.disabled) throw unauthorized('このアカウントは無効化されています');
      if (passwordFor(req.username) !== req.password)
        throw unauthorized('ユーザーIDまたはパスワードが違います');
      // session と現在の起動 epoch を対で保存する(`currentUser` が epoch 不一致=再起動を
      // 検知して再ログインを促すため)。
      write(K.session, user.id);
      write(K.sessionEpoch, currentAppEpoch());
      return delay({ user, mustChangePassword: user.mustChangePassword });
    }),

  logout: () =>
    attempt(() => {
      localStorage.removeItem(K.session);
      localStorage.removeItem(K.sessionEpoch);
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
