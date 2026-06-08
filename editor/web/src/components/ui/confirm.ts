import { ref } from 'vue';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'destructive' renders the confirm button in the danger style. */
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

/** Open a global confirmation dialog. Resolves true on confirm, false on cancel/dismiss. */
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
