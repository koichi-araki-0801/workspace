// =============================================================================
// toast.ts — トースト通知の reactive ストアと発火ヘルパ
// =============================================================================
// `Toaster.vue` が購読する `toasts` 配列を保持し、`toast()` で push、`durationMs`
// 経過後に自動 dismiss する。`toastSuccess`/`toastError` は variant 固定の薄い糖衣。
import { reactive } from 'vue';

export type ToastVariant = 'default' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

let seq = 0;
export const toasts = reactive<Toast[]>([]);

export function dismissToast(id: number): void {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}

export function toast(message: string, variant: ToastVariant = 'default', durationMs = 3000): void {
  const id = ++seq;
  toasts.push({ id, message, variant });
  window.setTimeout(() => dismissToast(id), durationMs);
}

export const toastSuccess = (m: string) => toast(m, 'success');
export const toastError = (m: string) => toast(m, 'error');
