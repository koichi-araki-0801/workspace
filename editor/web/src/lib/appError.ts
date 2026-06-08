/**
 * Web-side helpers around the shared {@link AppError} model.
 *
 * - {@link logError} makes every failure observable (always logs, not DEV-only).
 * - {@link toUserMessage} extracts the safe, user-facing sentence.
 *
 * `AppError.message` is authored to be safe to show, so this layer no longer
 * needs the old whitelist of "user-facing" strings.
 */

import { type AppError, isAppError, toAppError } from '@editor/shared';

export type { AppError };
export { toAppError };

/** Log an error (and its technical cause) so failures are never silent. */
export function logError(e: unknown): void {
  if (isAppError(e)) {
    console.error(`[${e.kind}] ${e.message}`, e.cause ?? '');
  } else {
    console.error(e);
  }
}

/**
 * The message to show a user. An {@link AppError}'s message is always safe;
 * anything else falls back to the caller-supplied sentence. Pure — call
 * {@link logError} separately when you also need the failure logged.
 */
export function toUserMessage(e: unknown, fallback: string): string {
  return isAppError(e) ? e.message : fallback;
}
