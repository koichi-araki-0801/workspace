// =============================================================================
// authRepo.ts — 認証の local 実装(fixtures + localStorage によるログイン/PW)
// =============================================================================
import {
  type AuthRepository,
  type LoginRequest,
  PASSWORD_MIN_LENGTH,
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
      // 存在有無を漏らさないため、未知の id も現行パスワード誤りも同一メッセージにする
      // (rest 実装 `server/src/repositories/authRepo.ts` と同じ判定順・同じ文言)。
      if (!user) throw unauthorized('ユーザーIDまたはパスワードが違います');
      if (user.disabled) throw unauthorized('このアカウントは無効化されています');
      // 所有証明。local は平文比較だが、rest 同様「現行を知らなければ変えられない」を守る。
      if (passwordFor(req.username) !== req.currentPassword)
        throw unauthorized('ユーザーIDまたはパスワードが違います');
      // client と同一基準で検証する(空白のみ=実質空も弾く)。UI を経由しない経路の保険。
      if (req.newPassword.trim().length < PASSWORD_MIN_LENGTH)
        throw validation('新しいパスワードが短すぎます');
      const pw = read<Record<string, string>>(K.passwords, {});
      pw[req.username] = req.newPassword;
      write(K.passwords, pw);
      const overrides = read<Record<string, Partial<User>>>(K.userOverride, {});
      overrides[user.id] = { ...overrides[user.id], mustChangePassword: false };
      write(K.userOverride, overrides);
      return delay(undefined);
    }),
};
