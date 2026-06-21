// =============================================================================
// confirm.ts — グローバル確認ダイアログの状態とプロミス API
// =============================================================================
// `ConfirmDialog.vue` が購読する単一の `confirmState` を介して `confirm()` を
// Promise<boolean> として提供する。表示部品と呼び出し側を疎結合に保つ。
import { ref } from 'vue';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `'destructive'` は確認ボタンを danger スタイルで描画する。 */
  variant?: 'default' | 'destructive';
}

interface ConfirmState extends Required<Omit<ConfirmOptions, 'description'>> {
  description?: string;
  open: boolean;
  resolve: ((ok: boolean) => void) | null;
}

export const confirmState = ref<ConfirmState>({
  title: '',
  description: undefined,
  confirmLabel: 'OK',
  cancelLabel: 'キャンセル',
  variant: 'default',
  open: false,
  resolve: null,
});

/** グローバル確認ダイアログを開く。確認で `true`、キャンセル/dismiss で `false` を resolve する。 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = {
      title: opts.title,
      description: opts.description,
      confirmLabel: opts.confirmLabel ?? 'OK',
      cancelLabel: opts.cancelLabel ?? 'キャンセル',
      variant: opts.variant ?? 'default',
      open: true,
      resolve,
    };
  });
}

export function resolveConfirm(ok: boolean): void {
  confirmState.value.resolve?.(ok);
  confirmState.value.open = false;
  confirmState.value.resolve = null;
}
