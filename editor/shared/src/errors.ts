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

/**
 * 承認申請が決着済み(承認・却下済み)のため、判定・最終確定・申請ごと却下を受け付けない 409 の
 * `code`。画面は文言でなくこれで「読み直す」へ分岐する。
 */
export const REVIEW_ALREADY_DECIDED = 'REVIEW_ALREADY_DECIDED';
/** パーツ判定の遷移が許されない(ほかの人が先に判定した)409 の `code`。 */
export const REVIEW_PART_DECISION_TRANSITION = 'REVIEW_PART_DECISION_TRANSITION';
/**
 * 作成経路の申請を承認画面に出せない(サーバが本文を描けなかった・描いた本文が応答に無い)ときの
 * `code`。web の承認画面が組み立てる失敗に付け、読み込みの失敗の汎用の文言の代わりにその理由を出す。
 */
export const REVIEW_RENDER_ERROR = 'REVIEW_RENDER_ERROR';
/**
 * 申請の後で確定版(本文の外側。編集経路の却下の戻し先も)が変わったため、判定・最終確定を
 * 受け付けない 409 の `code`。承認が後から入った変更を黙って巻き戻さないために止める。
 */
export const REVIEW_BASE_CHANGED = 'REVIEW_BASE_CHANGED';
/**
 * 申請が今の受付の検査(本文の外側・骨格・承認画面と本番で読みが割れる原文・往復用の印)を通らない
 * ため、判定・最終確定を受け付けない 409 の `code`。検査を足す前に積まれた申請がここに当たる。
 */
export const REVIEW_NOT_REVIEWABLE = 'REVIEW_NOT_REVIEWABLE';
/**
 * 同じ人の PDF 出力(ビルド・結合・プロジェクト・プレビューの展開)が「実行中 1・待ち 1」を
 * 超えたときの 503 の `code`。共有の枠(全員で数台)を 1 人で埋めさせないため
 * (`server/src/vivliostyle/buildUserQuota.ts`)。web の PDF 出力の画面は code を見て文言を出す。
 */
export const BUILD_BUSY_USER = 'BUILD_BUSY_USER';
/** `BUILD_BUSY_USER` の文言。server が返し、web が同じ文を出す。 */
export const BUILD_BUSY_USER_MESSAGE = '前の PDF の出力が終わってから、もう一度出してください';

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
 * — リポジトリの throw→Result の継ぎ目で使う。`fallbackKind` はテストから直接検証するために
 * 公開している引数。
 */
export function toAppError(cause: unknown, fallbackKind: AppErrorKind = 'unexpected'): AppError {
  if (isAppError(cause)) return cause;
  return { kind: fallbackKind, message: DEFAULT_ERROR_MESSAGE, cause };
}
