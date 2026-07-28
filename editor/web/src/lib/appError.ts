// =============================================================================
// appError.ts — 共有 `AppError` モデルの Web 側ヘルパ
// =============================================================================
// 役割:
//   - `logError` は全失敗を観測可能にする(DEV のみでなく常にログ出力する)。
//   - `toUserMessage` は安全なユーザー向け文面を取り出す。
//
// `AppError.message` は表示しても安全な文面として書かれているため, この層は
// かつての "user-facing" 文字列ホワイトリストをもう必要としない。

import { isAppError } from '@editor/shared';

/** エラー(と技術的な `cause`)をログ出力し, 失敗が無言で消えないようにする。 */
export function logError(e: unknown): void {
  if (isAppError(e)) {
    console.error(`[${e.kind}] ${e.message}`, e.cause ?? '');
  } else {
    console.error(e);
  }
}

/**
 * ユーザーに表示する文面。`AppError` の `message` は常に安全。それ以外は呼び出し側が
 * 渡す `fallback` 文面へフォールバックする。純粋関数 — ログも必要なら `logError` を
 * 別途呼ぶこと。
 */
export function toUserMessage(e: unknown, fallback: string): string {
  return isAppError(e) ? e.message : fallback;
}
