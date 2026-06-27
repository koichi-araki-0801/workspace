<script lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';

// `width` は各画面で散在していた `min-w-[XXXpx]` を離散値として保持する。値を統一すると
// フォーム行の折返し挙動 (狭幅/ズーム時のレイアウト) が変わるため、敢えて既存値を温存する。
// `grow` は `flex-1` の有無 (日時欄など固定幅で詰めたい行は `false`)。
export const formFieldVariants = cva('space-y-1.5', {
  variants: {
    width: {
      xs: 'min-w-[140px]',
      sm: 'min-w-[160px]',
      md: 'min-w-[180px]',
      lg: 'min-w-[190px]',
      xl: 'min-w-[220px]',
    },
    grow: { true: 'flex-1', false: '' },
  },
  defaultVariants: { width: 'md', grow: true },
});

export type FormFieldVariants = VariantProps<typeof formFieldVariants>;
</script>

<script setup lang="ts">
// =============================================================================
// FormField.vue — `Label` + 制御要素を縦に積むフォーム行 (`cva` で幅/伸長を切替)
// =============================================================================
// `SearchFilters` / `HistoryFilters` / `AdminView` 等で繰り返していた
// `min-w-[…] flex-1 space-y-1.5` の薄いラッパ。中身 (Label/Input/Select/Combobox) と
// 配線は呼び出し側のままで、外枠のレイアウトだけを集約する。
import { cn } from '@/lib/utils';

defineProps<{
  width?: FormFieldVariants['width'];
  grow?: FormFieldVariants['grow'];
  class?: string;
}>();
</script>

<template>
  <div :class="cn(formFieldVariants({ width, grow }), $props.class)">
    <slot />
  </div>
</template>
