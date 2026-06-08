/**
 * A tiny Result<T, E> type so failures travel as values instead of exceptions.
 *
 * Repositories and services return `Result`; callers branch on {@link isOk} /
 * {@link isErr} (the compiler forces them to). `throw` is reserved for true
 * programmer errors (missing DI, exhaustiveness guards), never control flow.
 */

import type { AppError } from './errors.js';

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Transform the success value; pass an error through unchanged. */
export const map = <T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

/** Transform the error; pass a success through unchanged. */
export const mapErr = <T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> =>
  r.ok ? r : err(f(r.error));

/** Chain a Result-returning step; short-circuits on the first error. */
export const andThen = <T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> =>
  r.ok ? f(r.value) : r;

/** Async {@link andThen}: chain an async Result-returning step. */
export const andThenAsync = async <T, U, E>(
  r: Result<T, E>,
  f: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> => (r.ok ? f(r.value) : r);

/** The success value, or `fallback` when the Result is an error. */
export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);
