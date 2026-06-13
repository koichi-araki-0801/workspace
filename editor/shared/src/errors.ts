/**
 * Application error model shared by the web and server layers.
 *
 * Errors cross layer boundaries as values, not thrown exceptions: a repository
 * converts every failure into an {@link AppError} and returns it inside an
 * `Err`. The `message` is always safe to show a user; technical detail lives in
 * `cause` and is for logging only.
 */

export type AppErrorKind =
  | 'not_found'
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'network'
  | 'unexpected';

export interface AppError {
  kind: AppErrorKind;
  /** User-facing, localized (JP). ALWAYS safe to display. */
  message: string;
  /** Original thrown value / network detail. Log only — never shown to users. */
  cause?: unknown;
  /** Optional machine-readable code, e.g. 'USER_DISABLED'. */
  code?: string;
}

export interface AppErrorOptions {
  cause?: unknown;
  code?: string;
}

export function appError(kind: AppErrorKind, message: string, opts?: AppErrorOptions): AppError {
  return { kind, message, cause: opts?.cause, code: opts?.code };
}

export const notFound = (message: string, opts?: AppErrorOptions): AppError =>
  appError('not_found', message, opts);
export const validation = (message: string, opts?: AppErrorOptions): AppError =>
  appError('validation', message, opts);
export const unauthorized = (message: string, opts?: AppErrorOptions): AppError =>
  appError('unauthorized', message, opts);
export const forbidden = (message: string, opts?: AppErrorOptions): AppError =>
  appError('forbidden', message, opts);
export const conflict = (message: string, opts?: AppErrorOptions): AppError =>
  appError('conflict', message, opts);
export const network = (message: string, opts?: AppErrorOptions): AppError =>
  appError('network', message, opts);
export const unexpected = (message: string, opts?: AppErrorOptions): AppError =>
  appError('unexpected', message, opts);

/** Generic, safe message used when a failure carries no user-facing text. */
export const DEFAULT_ERROR_MESSAGE = '予期しないエラーが発生しました';

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  );
}

/**
 * Wrap any thrown/caught value into an {@link AppError}. Already-AppError values
 * pass through unchanged. Unknown throws get a generic safe message with the
 * original preserved in `cause` — used by repositories at the throw→Result seam.
 */
export function toAppError(cause: unknown, fallbackKind: AppErrorKind = 'unexpected'): AppError {
  if (isAppError(cause)) return cause;
  return { kind: fallbackKind, message: DEFAULT_ERROR_MESSAGE, cause };
}
