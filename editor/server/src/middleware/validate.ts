// =============================================================================
// validate.ts — リクエストボディ検証ミドルウェア
// =============================================================================
// ルートごとの `safeParse` + 400 ボイラープレートを置き換える。Zod スキーマを渡すと、
// パース済み(かつ絞り込み済み)の値を `req.body` へ書き戻す。失敗時は `validation` の
// `AppError` を集中エラーハンドラ(`errorHandler.ts`)へ転送する。
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
