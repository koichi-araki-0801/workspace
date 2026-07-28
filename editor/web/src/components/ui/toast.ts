// =============================================================================
// toast.ts — トースト通知の reactive ストアと発火ヘルパ
// =============================================================================
// `Toaster.vue` が購読する `toasts` 配列を保持し、`toast()` で push、`durationMs`
// 経過後に自動 dismiss する。`toastSuccess`/`toastError` は variant 固定の薄い糖衣。
import { reactive } from 'vue';

export type ToastVariant = 'default' | 'success' | 'error';

/** トースト内に置く操作ボタン(「元に戻す」等)。押下でハンドラ実行後に自動 dismiss する。 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
}

/** `toast()` の options 形式(第2引数がオブジェクトのとき)。 */
interface ToastOptions {
  variant?: ToastVariant;
  durationMs?: number;
  action?: ToastAction;
}

let seq = 0;
export const toasts = reactive<Toast[]>([]);

export function dismissToast(id: number): void {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

// 表示時間の既定は文字数連動にする — 固定 3 秒では長文(初期パスワード案内等)を読み切れない。
// 下限 3 秒(従来互換)・上限 8 秒(占有しすぎない)の間で 1 文字 60ms を目安に伸ばす。
export function defaultDurationMs(message: string): number {
  return Math.min(8000, Math.max(3000, message.length * 60));
}

export function toast(message: string, variant?: ToastVariant, durationMs?: number): void;
export function toast(message: string, options?: ToastOptions): void;
export function toast(
  message: string,
  variantOrOptions: ToastVariant | ToastOptions = 'default',
  durationMs?: number,
): void {
  // 位置引数(旧 API)と options オブジェクトの両対応。既存呼び出しは無改修で動く。
  const opts: ToastOptions =
    typeof variantOrOptions === 'string'
      ? { variant: variantOrOptions, durationMs }
      : variantOrOptions;
  const id = ++seq;
  toasts.push({ id, message, variant: opts.variant ?? 'default', action: opts.action });
  window.setTimeout(() => dismissToast(id), opts.durationMs ?? defaultDurationMs(message));
}

export const toastSuccess = (m: string) => toast(m, 'success');
export const toastError = (m: string) => toast(m, 'error');
