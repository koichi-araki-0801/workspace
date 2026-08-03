// =============================================================================
// userRepo.ts — ユーザー管理の local 実装(一覧/作成/更新/PW リセット)
// =============================================================================
// rest 実装(`server/src/repositories/userRepo.ts`)と同じ意味論を守る: 初期 / リセットの
// パスワードは CSPRNG 由来の一時パスワードで、平文は戻り値で 1 回だけ返す。ログインID を
// 初期パスワードにする実装へは戻さない(ID を知る者が未活性アカウントへ入れてしまう)。
// 生成器は server と重複するが、runtime が違う(server=`node:crypto` / web=Web Crypto)ため
// 共通化せず、文字集合と桁数だけを揃えている。
import {
  type CreatedUser,
  isErr,
  notFound,
  type PasswordResetResult,
  type User,
  type UserRepository,
} from '@editor/shared';
import { attempt } from './attempt';
import { delay, K, listUsersSync, read, uid, write } from './store';

/**
 * 一時パスワードの文字集合。判読を誤りやすい `0` `O` `1` `I` `l` を落としてある。
 * ちょうど 32 文字なので 1 バイトの剰余が一様になり、剰余バイアスが出ない。
 */
const TEMP_PASSWORD_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** 一時パスワードの文字数。1 文字 5 bit なので 12 文字 = 60 bit。 */
const TEMP_PASSWORD_LENGTH = 12;

function generateTemporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TEMP_PASSWORD_LENGTH));
  let out = '';
  for (const b of bytes) out += TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length];
  return out;
}

/** 生成した一時パスワードを local の資格情報ストアへ書き、平文を呼び出し元へ返す。 */
function issueTemporaryPassword(username: string): string {
  const temporaryPassword = generateTemporaryPassword();
  const pw = read<Record<string, string>>(K.passwords, {});
  pw[username] = temporaryPassword;
  write(K.passwords, pw);
  return temporaryPassword;
}

export const localUserRepo: UserRepository = {
  listUsers: () => attempt(() => delay(listUsersSync())),

  createUser: (user: Omit<User, 'id'>) =>
    attempt(() => {
      const overrides = read<Record<string, Partial<User>>>(K.userOverride, {});
      const id = uid('u');
      overrides[id] = { ...user };
      write(K.userOverride, overrides);
      const temporaryPassword = issueTemporaryPassword(user.username);
      return delay<CreatedUser>({ user: { id, ...user }, temporaryPassword });
    }),

  updateUser: (id: string, patch: Partial<Omit<User, 'id'>>) =>
    attempt(() => {
      const overrides = read<Record<string, Partial<User>>>(K.userOverride, {});
      overrides[id] = { ...overrides[id], ...patch };
      write(K.userOverride, overrides);
      const updated = listUsersSync().find((u) => u.id === id);
      if (!updated) throw notFound(`ユーザーが見つかりません: ${id}`);
      return delay(updated);
    }),

  resetUserPassword: (id: string) =>
    attempt(async () => {
      const user = listUsersSync().find((u) => u.id === id);
      if (!user) throw notFound(`ユーザーが見つかりません: ${id}`);
      const temporaryPassword = issueTemporaryPassword(user.username);
      const updated = await localUserRepo.updateUser(id, { mustChangePassword: true });
      if (isErr(updated)) throw updated.error;
      return delay<PasswordResetResult>({ temporaryPassword });
    }),
};
