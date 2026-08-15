// =============================================================================
// errors.ts — web/server 共通のアプリケーションエラーモデル
// =============================================================================
// エラーは throw する例外ではなく値として層境界を越える: リポジトリは全ての失敗を
// `AppError` へ変換し `Err` に入れて返す。`message` は常にユーザー表示しても安全で、
// 技術的詳細は `cause` に入れてログ専用とする。

// 許可される kind の正典。`schemas.ts` の `z.enum` と REST 応答の照合(`web/src/api/rest/http.ts`)
// がここから読む — 3 箇所へ手書き複製すると 1 つだけ更新漏れて未知 kind を通す穴になる。
export const APP_ERROR_KINDS = [
  'not_found',
  'validation',
  'unauthorized',
  'forbidden',
  'conflict',
  'network',
  'unexpected',
] as const;

export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

/** `v` が既知の `AppErrorKind` か。外部由来(REST 応答等)の文字列を信用する前に通す。 */
export function isAppErrorKind(v: unknown): v is AppErrorKind {
  return typeof v === 'string' && (APP_ERROR_KINDS as readonly string[]).includes(v);
}

export interface AppError {
  kind: AppErrorKind;
  /** ユーザー向け・日本語ローカライズ済み。常に表示して安全。 */
  message: string;
  /** 元の throw 値 / ネットワーク詳細。ログ専用 — ユーザーには出さない。 */
  cause?: unknown;
  /** 機械可読の任意コード。例 `'USER_DISABLED'`。 */
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

/** 失敗にユーザー向けテキストが無いときに使う、汎用で安全なメッセージ。 */
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
 * throw/catch した任意の値を `AppError` に包む。既に `AppError` ならそのまま返す。
 * 未知の throw には汎用の安全なメッセージを与え、元の値は `cause` に保持する
 * — リポジトリの throw→Result の継ぎ目で使う。
 */
export function toAppError(cause: unknown, fallbackKind: AppErrorKind = 'unexpected'): AppError {
  if (isAppError(cause)) return cause;
  return { kind: fallbackKind, message: DEFAULT_ERROR_MESSAGE, cause };
}
