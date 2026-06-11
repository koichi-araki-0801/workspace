/**
 * Central error-handling middleware.
 *
 * Route handlers stay lean: they `throw` (Express 5 forwards async throws here
 * automatically) and this one place normalizes the failure into the shared
 * {@link AppError} shape and picks the HTTP status. The user-facing `message`
 * is always safe to show; the technical `cause` is logged only, never sent.
 */
import { type AppError, type AppErrorKind, toAppError } from '@editor/shared';
import type { ErrorRequestHandler } from 'express';

/** Map a domain error kind to its HTTP status code. */
export function statusForKind(kind: AppErrorKind): number {
  switch (kind) {
    case 'validation':
      return 400;
    case 'unauthorized':
      return 401;
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

/** Client-safe error body: the shared AppError minus the log-only `cause`. */
type ErrorBody = Pick<AppError, 'kind' | 'message' | 'code'>;

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already flushed (e.g. a streamed PDF failed mid-send): defer to
  // Express's default handler, which aborts the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);
  const status = statusForKind(appError.kind);

  // Log the full error (cause included) but never leak it to the client.
  req.log?.error({ err, kind: appError.kind, status }, appError.message);

  const body: ErrorBody = { kind: appError.kind, message: appError.message };
  if (appError.code) body.code = appError.code;
  res.status(status).json(body);
};
