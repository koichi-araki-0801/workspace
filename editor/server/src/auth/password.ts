// =============================================================================
// password.ts — editor 独自認証のパスワードハッシュ
// =============================================================================
// `node:crypto` の PBKDF2 のみを使う。外部依存が無いのでエアギャップ配布でも
// クリーンに同梱できる。導出鍵 `hash` + `salt` はユーザーテーブルに VARBINARY で
// 保存し、平文は一切永続化しない。検証は定数時間比較 (`timingSafeEqual`)。
//
// KDF は**非同期版のみ**を公開する。同期版 (`pbkdf2Sync`) は未認証で到達できる
// `POST /auth/login` から 12 万回反復を Fastify の単一イベントループ上で回すため、
// 数十 req/s の総当たりで編集・プレビュー・PDF まで含む全リクエストが停止する。
// `promisify(pbkdf2)` は libuv のスレッドプールで走るのでイベントループを塞がない。
// 併せて到達回数そのものを `loginRateLimit.ts` が絞る(CPU 予算の上限を決める)。
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

/** PBKDF2 の既定イテレーション数。行ごとに保存するので後から引き上げ可能。 */
const PBKDF2_ITERATIONS = 120_000;
/** 導出鍵長(バイト)。ユーザーテーブルの VARBINARY(64) に収まる。 */
const KEY_LEN = 64;
/** ソルト長(バイト)。VARBINARY(32) に収まる。 */
const SALT_LEN = 32;
const DIGEST = 'sha512';

/**
 * 一時パスワードの文字集合。管理者が画面から読み取り、紙や口頭で本人へ渡す前提なので
 * 判読を誤りやすい `0` `O` `1` `I` `l` を落とす(小文字は使わない)。ちょうど 32 文字に
 * してあるため `randomBytes` の 1 バイトを 32 で割った剰余が一様になり、棄却抽出も
 * 剰余バイアス補正も要らない。
 */
const TEMP_PASSWORD_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** 一時パスワードの文字数。1 文字 5 bit なので 12 文字 = 60 bit。 */
const TEMP_PASSWORD_LENGTH = 12;

interface PasswordHash {
  hash: Buffer;
  salt: Buffer;
  iterations: number;
}

/**
 * 新規作成 / 管理者リセットで配る一時パスワードを CSPRNG から作る。
 * 呼び出し元は生成した平文を「その応答で 1 回だけ」返し、ログにも DB にも残さないこと
 * (残す = ログイン ID と同じ推測可能な既定資格情報へ逆戻りする)。
 */
export function generateTemporaryPassword(): string {
  const bytes = randomBytes(TEMP_PASSWORD_LENGTH);
  let out = '';
  for (const b of bytes) out += TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length];
  return out;
}

/** 平文パスワードを毎回新規のランダム `salt` でハッシュする。 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<PasswordHash> {
  const salt = randomBytes(SALT_LEN);
  const hash = await pbkdf2Async(password, salt, iterations, KEY_LEN, DIGEST);
  return { hash, salt, iterations };
}

/**
 * 入力パスワードを保存済みの `hash` / `salt` と定数時間比較する。
 * 保存フィールドが欠落/不正なときは false を返す(例外は投げない)。
 */
export async function verifyPassword(
  password: string,
  hash: Buffer | null | undefined,
  salt: Buffer | null | undefined,
  iterations: number | null | undefined,
): Promise<boolean> {
  if (!hash || !salt || !iterations) return false;
  const candidate = await pbkdf2Async(password, salt, iterations, hash.length, DIGEST);
  return candidate.length === hash.length && timingSafeEqual(candidate, hash);
}
