<script setup lang="ts">
// =============================================================================
// Label.vue — フォーム要素のラベル(`for` で関連付け、peer-disabled に追従)
// =============================================================================
import { cn } from '@/lib/utils';

defineProps<{ class?: string; for?: string }>();
</script>

<template>
  <label
    :for="$props.for"
    :class="cn('text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50', $props.class)"
  >
    <slot />
  </label>
</template>
