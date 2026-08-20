// =============================================================================
// sessionExpiry.ts — セッション切れ(401)のグローバル通知
// =============================================================================
// 役割: 401 は「サーバ側のセッションがもう無い」で、個々の呼び出し元へ Result で返すだけ
// だと画面は認証済みのまま残り、以後の操作がすべて静かに失敗する。REST トランスポート
// (`http.ts`)が 1 回だけここへ通知し、`main.ts` が auth state のリセットとログイン画面への
// 退避を行う。一斉に投げた要求が全部 401 になる形が普通なので、通知は再武装まで 1 回に抑える。

let handler: (() => void) | null = null;
let notified = false;

/** セッション切れの通知先を設定する(rest 配線時に `main.ts` が 1 回だけ呼ぶ)。 */
export function setUnauthorizedHandler(next: (() => void) | null): void {
  handler = next;
  notified = false;
}

/** 通知を再武装する(ログイン成功時。次のセッション切れでまた 1 回通知する)。 */
export function armUnauthorizedNotice(): void {
  notified = false;
}

/** セッション切れを通知する(再武装まで 1 回だけ handler を呼ぶ)。 */
export function notifyUnauthorized(): void {
  if (notified) return;
  notified = true;
  handler?.();
}
