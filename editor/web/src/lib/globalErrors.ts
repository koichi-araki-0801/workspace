// =============================================================================
// globalErrors.ts — `useAsyncResult().run()` に届かない失敗の最終 handler
// =============================================================================
// Vue の render/lifecycle エラー、unhandled promise rejection、生の global `error`
// イベント(例 GrapesJS コールバック, dynamic import)を拾う。これが無いとそうした失敗は
// console に出るだけで、ユーザーには何のフィードバックも残らない。
import { toAppError } from '@editor/shared';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';

// 短い dedupe: ループ内でエラーが連発しても同一 toast の連投を避ける。
let lastMessage = '';

export function reportGlobalError(e: unknown): void {
  const ae = toAppError(e);
  logError(ae);
  if (ae.message !== lastMessage) {
    lastMessage = ae.message;
    toastError(ae.message);
  }
}

/**
 * `ResizeObserver loop completed with undelivered notifications`(および limit exceeded)は、
 * 監視コールバック内の再レイアウトで 1 フレームに配信しきれなかった通知がある、という
 * **良性の警告**(次フレームで配信され実害なし)。ブラウザはこれを global `error` として
 * 上げる。
 */
export function isBenignResizeObserverError(message: unknown): boolean {
  return typeof message === 'string' && message.includes('ResizeObserver loop');
}

/**
 * `window` の `error` イベント handler。RO の良性警告は握りつぶさず `logError` へは通す
 * (観測は残す)が、握りつぶさないと比較結果(`iframe` リサイズ)のたび「予期しないエラー」
 * toast が出てしまうため toast だけ抑制する。それ以外は通常どおり `reportGlobalError`
 * (logError + toast)へ流す。
 */
export function handleWindowError(ev: ErrorEvent): void {
  if (isBenignResizeObserverError(ev.message)) {
    logError(toAppError(ev.message));
    return;
  }
  reportGlobalError(ev.error ?? ev.message);
}
