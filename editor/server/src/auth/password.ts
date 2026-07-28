// =============================================================================
// password.ts — editor 独自認証(フェーズ2)のパスワードハッシュ
// =============================================================================
// `node:crypto` の PBKDF2 のみを使う。外部依存が無いのでエアギャップ配布でも
// クリーンに同梱できる。導出鍵 `hash` + `salt` はユーザーテーブルに VARBINARY で
// 保存し、平文は一切永続化しない。検証は定数時間比較 (`timingSafeEqual`)。
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** PBKDF2 の既定イテレーション数。行ごとに保存するので後から引き上げ可能。 */
const PBKDF2_ITERATIONS = 120_000;
/** 導出鍵長(バイト)。ユーザーテーブルの VARBINARY(64) に収まる。 */
const KEY_LEN = 64;
/** ソルト長(バイト)。VARBINARY(32) に収まる。 */
const SALT_LEN = 32;
const DIGEST = 'sha512';

interface PasswordHash {
  hash: Buffer;
  salt: Buffer;
  iterations: number;
}

/** 平文パスワードを毎回新規のランダム `salt` でハッシュする。 */
export function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): PasswordHash {
  const salt = randomBytes(SALT_LEN);
  const hash = pbkdf2Sync(password, salt, iterations, KEY_LEN, DIGEST);
  return { hash, salt, iterations };
}

/**
 * 入力パスワードを保存済みの `hash` / `salt` と定数時間比較する。
 * 保存フィールドが欠落/不正なときは false を返す(例外は投げない)。
 */
export function verifyPassword(
  password: string,
  hash: Buffer | null | undefined,
  salt: Buffer | null | undefined,
  iterations: number | null | undefined,
): boolean {
  if (!hash || !salt || !iterations) return false;
  const candidate = pbkdf2Sync(password, salt, iterations, hash.length, DIGEST);
  return candidate.length === hash.length && timingSafeEqual(candidate, hash);
}
