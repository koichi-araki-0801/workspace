/**
 * Password hashing for the editor's own authentication (phase 2).
 *
 * PBKDF2 via `node:crypto` only — no external dependency, so it bundles cleanly
 * for the air-gapped deployment. The derived key + salt are stored as
 * VARBINARY in the user table; the plaintext is never persisted. Verification
 * is constant-time (`timingSafeEqual`).
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default PBKDF2 iterations. Stored per-row so it can be raised later. */
export const PBKDF2_ITERATIONS = 120_000;
/** Derived-key length (bytes). Fits the user table's VARBINARY(64). */
const KEY_LEN = 64;
/** Salt length (bytes). Fits VARBINARY(32). */
const SALT_LEN = 32;
const DIGEST = 'sha512';

export interface PasswordHash {
  hash: Buffer;
  salt: Buffer;
  iterations: number;
}

/** Hash a plaintext password with a fresh random salt. */
export function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): PasswordHash {
  const salt = randomBytes(SALT_LEN);
  const hash = pbkdf2Sync(password, salt, iterations, KEY_LEN, DIGEST);
  return { hash, salt, iterations };
}

/**
 * Constant-time check of a candidate password against a stored hash/salt.
 * Returns false (never throws) when any stored field is missing/malformed.
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
