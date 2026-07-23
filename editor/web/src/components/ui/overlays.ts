// =============================================================================
// overlays.ts — `reka-ui` のオーバーレイ系プリミティブを 1 ファイルへ集約したラッパ群
// =============================================================================
// Dialog / DropdownMenu(+Item) / Tooltip を Tailwind クラス込みで提供する。薄い SFC の
// 乱立を避けるため「1 ファイル複数コンポーネント」の h() 方式(`table.ts`・`toast.ts` と
// 同じ流儀)で集約する。Overlay/Content のクラスは AlertDialog 系の `ConfirmDialog.vue`
// とも共有するため、cva 定数 (`dialogOverlayClass` / `dialogContentClass`) として export
// する(見た目の単一情報源をここに置き、ダイアログ間のスタイル乖離を防ぐ)。
import { X } from '@lucide/vue';
import { cva } from 'class-variance-authority';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { defineComponent, h, type PropType } from 'vue';
import { cn } from '@/lib/utils';

// ── 1. 共有クラス定数 ──────────────────────────────────────────────────────────

export const dialogOverlayClass =
  'fixed inset-0 z-[90] bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0';

export const dialogContentClass = cva(
  'fixed left-1/2 top-1/2 z-[100] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-6 text-card-foreground shadow-lg duration-200 focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
  {
    variants: { size: { sm: 'max-w-sm', md: 'max-w-md' } },
    defaultVariants: { size: 'md' },
  },
);

// ── 2. Dialog ──────────────────────────────────────────────────────────────────

// 汎用モーダル。タイトル/説明/右上の X close を内蔵し、本文は default slot で受ける。
// 確認ダイアログ(2 ボタン + capture resolve)は挙動が特殊なため `ConfirmDialog.vue` が
// AlertDialog 系のまま担当し、本コンポーネントへは統合しない。
export const Dialog = defineComponent({
  name: 'Dialog',
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, required: true },
    description: { type: String, default: undefined },
    size: { type: String as PropType<'sm' | 'md'>, default: 'md' },
    contentClass: { type: String, default: undefined },
  },
  emits: ['update:open'],
  setup(props, { slots, emit }) {
    return () =>
      h(
        DialogRoot,
        {
          open: props.open,
          'onUpdate:open': (value: boolean) => emit('update:open', value),
        },
        () =>
          h(DialogPortal, null, () => [
            h(DialogOverlay, { class: dialogOverlayClass }),
            h(
              DialogContent,
              { class: cn(dialogContentClass({ size: props.size }), props.contentClass) },
              () => [
                h(DialogTitle, { class: 'text-base font-semibold' }, () => props.title),
                props.description
                  ? h(
                      DialogDescription,
                      { class: 'mt-1 text-xs text-muted-foreground' },
                      () => props.description,
                    )
                  : null,
                slots.default?.(),
                h(
                  DialogClose,
                  {
                    class:
                      'absolute right-4 top-4 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'aria-label': '閉じる',
                  },
                  () => h(X, { class: 'h-4 w-4' }),
                ),
              ],
            ),
          ]),
      );
  },
});
