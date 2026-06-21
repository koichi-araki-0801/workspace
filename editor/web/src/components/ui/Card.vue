<script setup lang="ts">
// =============================================================================
// Card.vue — 角丸ボーダー＋ shadow のカードコンテナ
// =============================================================================
import { cn } from '@/lib/utils';

defineProps<{ class?: string }>();
</script>

<template>
  <div :class="cn('rounded-xl border bg-card text-card-foreground shadow-sm', $props.class)">
    <slot />
  </div>
</template>
