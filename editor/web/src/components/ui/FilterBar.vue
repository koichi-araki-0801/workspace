<script lang="ts">
import { cva } from 'class-variance-authority';

// `bare` 時はカード装飾を外す (例 step card 内や比較 A/B の埋め込み)。装飾ありが既定。
const filterBarVariants = cva('', {
  variants: {
    bare: { true: '', false: 'rounded-lg border bg-card p-4' },
  },
  defaultVariants: { bare: false },
});

</script>

<script setup lang="ts">
// =============================================================================
// FilterBar.vue — フィルタ行を横に並べるカード枠 (既定 slot=フィールド行, footer slot)
// =============================================================================
// `SearchFilters` / `HistoryFilters` で重複していた
// 「`rounded-lg border bg-card p-4` の外枠 + `flex flex-wrap items-end gap-3` の行 +
// 区切り footer」を集約する。フィールド/ボタンの中身と配線は呼び出し側のまま。
import { cn } from '@/lib/utils';

defineProps<{ bare?: boolean; class?: string }>();
</script>

<template>
  <div :class="cn(filterBarVariants({ bare }), $props.class)">
    <div class="flex flex-wrap items-end gap-3">
      <slot />
    </div>
    <div v-if="$slots.footer" class="mt-4 border-t pt-4">
      <slot name="footer" />
    </div>
  </div>
</template>
