/**
 * Auth aggregate — server (REST) implementation. login/initPassword verify
 * against the user table via PBKDF2 (constant-time). login also opens a DB
 * session; the route sets the cookie from the returned id.
 */
import {
  type LoginRequest,
  type LoginResult,
  type PasswordInitRequest,
  unauthorized,
  validation,
} from '@editor/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, destroySession } from '../auth/session.js';
import { asBool, asBuffer, asNumberOrNull, callSproc, firstRow, p } from '../db/sproc.js';
import { SP } from '../db/sprocNames.js';
import { rowToUser } from './userRepo.js';

/** Verify credentials, open a session. Returns the result + new session id. */
export async function login(
  req: LoginRequest,
): Promise<{ result: LoginResult; sessionId: string }> {
  const row = firstRow(await callSproc(SP.user, '認証情報取得', [p('ログインID', req.username)]));
  // Same message for unknown id / wrong password (don't reveal which).
  if (!row) throw unauthorized('ユーザーIDまたはパスワードが違います');
  if (asBool(row.無効)) throw unauthorized('このアカウントは無効化されています');
  const ok = verifyPassword(
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

export async function initPassword(req: PasswordInitRequest): Promise<void> {
  const row = firstRow(await callSproc(SP.user, '認証情報取得', [p('ログインID', req.username)]));
  if (!row) throw unauthorized('ユーザーIDが見つかりません');
  if (asBool(row.無効)) throw unauthorized('このアカウントは無効化されています');
  if (req.newPassword.length < 4) throw validation('新しいパスワードが短すぎます');
  const { hash, salt, iterations } = hashPassword(req.newPassword);
  await callSproc(SP.user, 'PW初期化', [
    p('ログインID', req.username),
    p('PWハッシュ', hash),
    p('PWソルト', salt),
    p('PW反復回数', iterations),
  ]);
}
