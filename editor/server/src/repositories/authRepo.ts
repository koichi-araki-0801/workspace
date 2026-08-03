// =============================================================================
// authRepo.ts — 認証集約のサーバ(REST)実装
// =============================================================================
// `login` / `initPassword` はユーザテーブルに対し PBKDF2(定数時間比較)で資格情報を
// 検証する。`login` は併せて DB セッションを開き、ルート側が返却 id から cookie を張る。
// KDF は非同期版(libuv スレッドプール)なので全て await する — 同期版はイベントループを
// 12 万回反復ぶん占有し、ログインの連打だけでサーバ全体が止まる(`auth/password.ts`)。
// 試行回数そのものの制限はルート側(`auth.routes.ts` + `auth/loginRateLimit.ts`)の責務。
import {
  type LoginRequest,
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
import { rowToUser } from './userRepo.js';

/** 資格情報を検証しセッションを開く。結果と新しい session id を返す。 */
export async function login(
  req: LoginRequest,
): Promise<{ result: LoginResult; sessionId: string }> {
  const row = firstRow(await callSproc(SP.user, '認証情報取得', [p('ログインID', req.username)]));
  // 不明な id とパスワード誤りは同一メッセージにする(どちらかを漏らさない)。
  if (!row) throw unauthorized('ユーザーIDまたはパスワードが違います');
  if (asBool(row.無効)) throw unauthorized('このアカウントは無効化されています');
  const ok = await verifyPassword(
    req.password,
    asBuffer(row.PWハッシュ),
    asBuffer(row.PWソルト),
    asNumberOrNull(row.PW反復回数),
  );
  if (!ok) throw unauthorized('ユーザーIDまたはパスワードが違います');

  const user = rowToUser(row);
  const sessionId = await createSession(user.username);
  return { result: { user, mustChangePassword: user.mustChangePassword }, sessionId };
}

export async function logout(sessionId: string | undefined): Promise<void> {
  if (sessionId) await destroySession(sessionId);
}

/**
 * 自分自身のパスワードを変更する。呼び出し側(`auth.routes.ts`)がセッション所有者と
 * `req.username` の一致を保証し、ここでは現行パスワードによる所有証明を検証する。この 2 段が
 * 揃うまで本エンドポイントは未認証で任意アカウントを乗っ取れる状態だった。
 */
export async function initPassword(req: PasswordInitRequest): Promise<void> {
  const row = firstRow(await callSproc(SP.user, '認証情報取得', [p('ログインID', req.username)]));
  // 存在有無を漏らさないため、未知の id も現行パスワード誤りも同一メッセージにする。
  if (!row) throw unauthorized('ユーザーIDまたはパスワードが違います');
  if (asBool(row.無効)) throw unauthorized('このアカウントは無効化されています');
  const owns = await verifyPassword(
    req.currentPassword,
    asBuffer(row.PWハッシュ),
    asBuffer(row.PWソルト),
    asNumberOrNull(row.PW反復回数),
  );
  if (!owns) throw unauthorized('ユーザーIDまたはパスワードが違います');
  // 閾値は UI と同じ `PASSWORD_MIN_LENGTH`。空白のみ(実質空)も弾くため trim 後で測る。
  if (req.newPassword.trim().length < PASSWORD_MIN_LENGTH)
    throw validation('新しいパスワードが短すぎます');
  const { hash, salt, iterations } = await hashPassword(req.newPassword);
  await callSproc(SP.user, 'PW初期化', [
    p('ログインID', req.username),
    p('PWハッシュ', hash),
    p('PWソルト', salt),
    p('PW反復回数', iterations),
  ]);
}
