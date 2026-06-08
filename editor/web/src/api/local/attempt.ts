import { err, ok, type Result, toAppError } from '@editor/shared';

/**
 * The throw→Result seam for local repositories. Runs `fn` and returns
 * `ok(value)`; any throw becomes `err(AppError)`. Thrown `AppError`s (e.g.
 * `throw notFound(...)`) pass through unchanged, so a method can signal a known
 * failure with a plain `throw` and still return a typed error.
 */
export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(toAppError(e));
  }
}
