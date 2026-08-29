// =============================================================================
// validate.ts — リクエストボディ検証ミドルウェア(Fastify preHandler ファクトリ)
// =============================================================================
// ルートごとの `safeParse` + 400 ボイラープレートを置き換える。Zod スキーマを渡すと、
// パース済み(かつ絞り込み済み)の値を `request.body` へ書き戻す。失敗時は `validation` の
// `AppError` を throw し、集中エラーハンドラ(`errorHandler.ts` = `setErrorHandler`)へ転送する。
import { validation } from '@editor/shared';
import type { preHandlerHookHandler } from 'fastify';
import type { ZodType } from 'zod';
import { z } from 'zod';

export function validate(schema: ZodType): preHandlerHookHandler {
  return async (request) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      throw validation('リクエスト内容が不正です', { cause: z.prettifyError(parsed.error) });
    }
    request.body = parsed.data;
  };
}

/**
 * `validate` のクエリ版。`request.query` を Zod で検証し、パース済み(絞り込み済み)の値を
 * 書き戻す。ルートごとの手作業パース(`typeof q.x === 'string' ? ...`)と 400 ボイラープレートを
 * 一掃するために使う。失敗時は `validation` の `AppError` を throw し集中ハンドラへ転送する。
 */
export function validateQuery(schema: ZodType): preHandlerHookHandler {
  return async (request) => {
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      throw validation('リクエスト内容が不正です', { cause: z.prettifyError(parsed.error) });
    }
    request.query = parsed.data;
  };
}
