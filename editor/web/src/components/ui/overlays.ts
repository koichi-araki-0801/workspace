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
  DropdownMenuContent as RekaDropdownMenuContent,
  DropdownMenuItem as RekaDropdownMenuItem,
  DropdownMenuPortal as RekaDropdownMenuPortal,
  DropdownMenuRoot as RekaDropdownMenuRoot,
  DropdownMenuTrigger as RekaDropdownMenuTrigger,
  TooltipContent,
  TooltipPortal,
  TooltipRoot,
  TooltipTrigger,
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

// ── 3. DropdownMenu ────────────────────────────────────────────────────────────

const dropdownContentClass =
  'z-50 w-[200px] rounded-[11px] border bg-card p-1.5 text-card-foreground shadow-[var(--shadow-lg)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95';

const dropdownItemClass =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13px] font-medium outline-none data-[highlighted]:bg-accent';

// トリガは `#trigger` slot の要素を as-child でそのまま使う(ピル/ボタン等の見た目は
// 呼び出し側の責務)。コンテンツの枠スタイルだけを共通化し、差分は `contentClass` で足す。
export const DropdownMenu = defineComponent({
  name: 'DropdownMenu',
  props: {
    align: { type: String as PropType<'start' | 'center' | 'end'>, default: 'end' },
    sideOffset: { type: Number, default: 6 },
    contentClass: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () =>
      h(RekaDropdownMenuRoot, null, () => [
        h(RekaDropdownMenuTrigger, { asChild: true }, () => slots.trigger?.()),
        h(RekaDropdownMenuPortal, null, () =>
          h(
            RekaDropdownMenuContent,
            {
              align: props.align,
              sideOffset: props.sideOffset,
              class: cn(dropdownContentClass, props.contentClass),
            },
            () => slots.default?.(),
          ),
        ),
      ]);
  },
});

export const DropdownMenuItem = defineComponent({
  name: 'DropdownMenuItem',
  props: { class: { type: String, default: undefined } },
  emits: ['select'],
  setup(props, { slots, emit }) {
    return () =>
      h(
        RekaDropdownMenuItem,
        {
          class: cn(dropdownItemClass, props.class),
          onSelect: (event: Event) => emit('select', event),
        },
        () => slots.default?.(),
      );
  },
});

// ── 4. Tooltip ─────────────────────────────────────────────────────────────────

const tooltipContentClass =
  'z-50 rounded-md border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95';

// ネイティブ `title` 属性の置き換え(遅延・スタイル・表示位置を全画面で統一する)。
// 祖先に `TooltipProvider`(App.vue)が必須 — 無いと reka-ui が throw する。
// トリガは as-child で slot の実要素へ属性が付くため、a11y の `aria-label` は
// 呼び出し側のトリガ要素に持たせたままにする(Tooltip は hover/focus 時の視覚情報のみ)。
export const Tooltip = defineComponent({
  name: 'Tooltip',
  props: {
    text: { type: String, required: true },
    side: { type: String as PropType<'top' | 'right' | 'bottom' | 'left'>, default: 'bottom' },
    sideOffset: { type: Number, default: 6 },
    /** true でラップを外し素通しする(条件付きでヒント不要なトリガ用)。 */
    disabled: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return () =>
      props.disabled
        ? slots.default?.()
        : h(TooltipRoot, null, () => [
            h(TooltipTrigger, { asChild: true }, () => slots.default?.()),
            h(TooltipPortal, null, () =>
              h(
                TooltipContent,
                { side: props.side, sideOffset: props.sideOffset, class: tooltipContentClass },
                () => props.text,
              ),
            ),
          ]);
  },
});
