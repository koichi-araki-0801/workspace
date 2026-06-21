// =============================================================================
// result.ts — 失敗を例外でなく値として運ぶ小さな Result<T, E> 型
// =============================================================================
// リポジトリ・サービスは `Result` を返し、呼び出し側は `isOk` / `isErr` で分岐する
// (コンパイラが分岐を強制する)。`throw` は真のプログラマエラー (DI 欠落・網羅性
// ガード) 専用で、制御フローには使わない。

import type { AppError } from './errors.js';

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** 成功値を変換する。エラーはそのまま素通しする。 */
export const map = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

/** `Result` を返すステップを連結する。最初のエラーで短絡する。 */
export const andThen = <T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> =>
  r.ok ? f(r.value) : r;
