<script setup lang="ts">
// =============================================================================
// TableContainer.vue — テーブルを包む角丸ボーダー枠 (`overflow-hidden` で角を丸める)
// =============================================================================
// 各一覧テーブル (`TemplateTable` / `HistoryTable` / `CompareCandidateTable` /
// `AdminView`) で重複していた `overflow-hidden rounded-lg border bg-card` の容器。
// 複合 API の `Table` 本体には手を入れず、外枠だけをここへ集約する。
import { cn } from '@/lib/utils';

defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('overflow-hidden rounded-lg border bg-card', $props.class)">
    <slot />
  </div>
</template>
