/**
 * Request-body validation middleware.
 *
 * Replaces the per-route `safeParse` + 400 boilerplate: pass a Zod schema and
 * the parsed (and narrowed) value is written back to `req.body`. On failure it
 * forwards a `validation` {@link AppError} to the central error handler.
 */
import { validation } from '@editor/shared';
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { z } from 'zod';

export function validate(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(validation('リクエスト内容が不正です', { cause: z.prettifyError(parsed.error) }));
      return;
    }
    req.body = parsed.data;
    next();
  };
}
