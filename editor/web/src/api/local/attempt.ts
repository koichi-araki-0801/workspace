// =============================================================================
// attempt.ts — local リポジトリの throw→Result 変換シーム
// =============================================================================
import { err, ok, type Result, toAppError } from '@editor/shared';

/**
 * local リポジトリの throw→Result 変換シーム。`fn` を実行し `ok(value)` を返す。
 * 例外はすべて `err(AppError)` へ変換する。投げられた `AppError`(例:
 * `throw notFound(...)`)はそのまま透過するので、メソッドは素の `throw` で既知の
 * 失敗を表明しつつ型付きエラーを返せる。
 */
export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(toAppError(e));
  }
}
