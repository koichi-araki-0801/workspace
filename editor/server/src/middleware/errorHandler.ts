// =============================================================================
// errorHandler.ts — 集中エラーハンドリングミドルウェア
// =============================================================================
// ルートハンドラは `throw` するだけでよい(Express 5 は async の throw を自動でここへ
// 転送する)。この 1 箇所で失敗を共有の `AppError` 形へ正規化し、HTTP ステータスを決める。
// ユーザ向け `message` は常に表示して安全。技術的な `cause` はログのみで、送出しない。
import { type AppError, type AppErrorKind, toAppError } from '@editor/shared';
import type { ErrorRequestHandler } from 'express';

/** ドメインエラーの `kind` を HTTP ステータスコードへ対応づける。 */
export function statusForKind(kind: AppErrorKind): number {
  switch (kind) {
    case 'validation':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'network':
      return 502;
    default:
      return 500;
  }
}

/** クライアント安全なエラーボディ。共有 `AppError` からログ専用の `cause` を除いたもの。 */
type ErrorBody = Pick<AppError, 'kind' | 'message' | 'code'>;

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // ヘッダ送出済み(例: ストリーム配信中の PDF が途中で失敗)の場合は Express 既定の
  // ハンドラへ委譲する。既定ハンドラは接続を中断する。
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);
  const status = statusForKind(appError.kind);

  // 完全なエラー(`cause` 含む)をログに出すが、クライアントには決して漏らさない。
  req.log?.error({ err, kind: appError.kind, status }, appError.message);

  const body: ErrorBody = { kind: appError.kind, message: appError.message };
  if (appError.code) body.code = appError.code;
  res.status(status).json(body);
};
