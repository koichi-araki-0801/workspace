<script setup lang="ts">
// =============================================================================
// Skeleton.vue — ローディング中のプレースホルダ(パルスする灰ブロック)
// =============================================================================
// 「読み込み中…」の文言行と違い、実レイアウトと同じ構成で並べることで
// ロード完了時のレイアウトシフトを防ぐ。寸法は呼び出し側が class で与える。
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('animate-pulse rounded bg-muted', props.class)" aria-hidden="true" />
</template>
