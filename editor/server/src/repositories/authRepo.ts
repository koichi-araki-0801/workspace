// =============================================================================
// authRepo.ts — 認証集約のサーバ(REST)実装
// =============================================================================
// `login` / `initPassword` はユーザテーブルに対し PBKDF2(定数時間比較)で資格情報を
// 検証する。`login` は併せて DB セッションを開き、ルート側が返却 id から cookie を張る。
// KDF は非同期版(libuv スレッドプール)なので全て await する — 同期版はイベントループを
// 12 万回反復ぶん占有し、ログインの連打だけでサーバ全体が止まる(`auth/password.ts`)。
// 試行回数そのものの制限はルート側(`auth.routes.ts` + `auth/loginRateLimit.ts`)の責務。
//
// ★ 失敗応答から「その ID が存在するか」を読ませない。以前は未知 ID と無効アカウントで
// **文言が違い**、しかもどちらも KDF より前で return していた。文言を揃えるだけでは
// 足りない(応答時間が second channel として残る)ので、
//   1. 文言は module 定数 `INVALID_CREDENTIALS` の 1 箇所参照へ統一し、
//   2. 判定を溜めて `verifyPassword` の後で 1 回だけ throw し、
//   3. 応答時間の差はルート側の `applyFailureFloor` が吸収する
// の 3 点で塞ぐ。無効アカウントであることは応答からは消えるが、監査ログには残す。
//
// 未知 ID のときにダミーの KDF を回して時間を揃える案は採らない。未知 ID 1 リクエストの
// コストが 0ms から 60ms へ上がり、毎回違う ID を送るだけでスレッドプールを無制限に
// 占有できる(存在オラクルを塞ぐ修正がそのまま DoS 増幅器になる)。
import {
  type LoginResult,
  PASSWORD_MIN_LENGTH,
  type PasswordInitRequest,
  unauthorized,
  validation,
} from '@editor/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, destroySession } from '../auth/session.js';
import { asBool, asBuffer, asNumberOrNull, callSproc, firstRow, p } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';
import { audit } from '../logger.js';
import { rowToUser } from './userRepo.js';

/**
 * 資格情報の不一致で返す唯一の文言。未知 ID・無効アカウント・パスワード誤りの 3 分岐が
 * **同じ定数を参照する**ようにして、コピペのずれで文言が割れるのを防ぐ。
 */
const INVALID_CREDENTIALS = 'ユーザーIDまたはパスワードが違います';

/**
 * 資格情報を検証しセッションを開く。結果と新しい session id を返す。
 *
 * `loginId` は `canonicalLoginId` の戻り値を受け取る(`LoginRequest` を丸ごと受けると
 * 「正規化前の値を DB へ渡す」経路が型の上で作れてしまう)。
 */
export async function login(
  loginId: string,
  password: string,
): Promise<{ result: LoginResult; sessionId: string }> {
  const row = firstRow(await callSproc(SP.user, '認証情報取得', [p('ログインID', loginId)]));
  const disabled = row ? asBool(row.無効) : false;
  const ok = row
    ? await verifyPassword(
        password,
        asBuffer(row.PWハッシュ),
        asBuffer(row.PWソルト),
        asNumberOrNull(row.PW反復回数),
      )
    : false;
  if (!row || !ok || disabled) {
    // 無効アカウントへの試行は応答からは判別できないが、運用が追えるよう証跡は残す。
    if (row && ok && disabled)
      audit({ event: 'auth.login', outcome: 'failure', actor: loginId, error: 'account_disabled' });
    throw unauthorized(INVALID_CREDENTIALS);
  }

  const user = rowToUser(row);
  const sessionId = await createSession(user.username);
  return { result: { user, mustChangePassword: user.mustChangePassword }, sessionId };
}

export async function logout(sessionId: string | undefined): Promise<void> {
  if (sessionId) await destroySession(sessionId);
}

/**
 * 自分自身のパスワードを変更する。宛先 `loginId` はルート側が**セッション所有者から**
 * 導出して渡す(body からは取らない)。ここでは現行パスワードによる所有証明を検証する。
 *
 * `PW初期化` は同一トランザクション内でそのユーザーの他セッションを失効させる
 * (`db/sproc/user.sql`)。Node 側で 2 回 sproc を呼ぶ形にすると、間で落ちたときに
 * 「パスワードは変わったが旧セッションは生きている」という最悪の中間状態が残る。
 */
export async function initPassword(
  loginId: string,
  req: Pick<PasswordInitRequest, 'currentPassword' | 'newPassword'>,
  exceptSessionId?: string,
): Promise<void> {
  const row = firstRow(await callSproc(SP.user, '認証情報取得', [p('ログインID', loginId)]));
  const disabled = row ? asBool(row.無効) : false;
  const owns = row
    ? await verifyPassword(
        req.currentPassword,
        asBuffer(row.PWハッシュ),
        asBuffer(row.PWソルト),
        asNumberOrNull(row.PW反復回数),
      )
    : false;
  if (!row || !owns || disabled) throw unauthorized(INVALID_CREDENTIALS);
  // 閾値は UI と同じ `PASSWORD_MIN_LENGTH`。空白のみ(実質空)も弾くため trim 後で測る。
  if (req.newPassword.trim().length < PASSWORD_MIN_LENGTH)
    throw validation('新しいパスワードが短すぎます');
  const { hash, salt, iterations } = await hashPassword(req.newPassword);
  await callSproc(SP.user, 'PW初期化', [
    p('ログインID', loginId),
    p('PWハッシュ', hash),
    p('PWソルト', salt),
    p('PW反復回数', iterations),
    p('除外セッションID', exceptSessionId ?? null),
  ]);
}
