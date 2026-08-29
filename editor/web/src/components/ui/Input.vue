<script setup lang="ts">
// =============================================================================
// Input.vue — `v-model` 対応のテキスト入力(aria-invalid でエラー表示)
// =============================================================================
import { cn } from '@/lib/utils';

defineProps<{ class?: string; placeholder?: string; type?: string; disabled?: boolean }>();
const model = defineModel<string | number>();
</script>

<template>
  <input
    v-model="model"
    :type="type ?? 'text'"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="
      cn(
        'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors duration-150 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/40 aria-invalid:focus-visible:ring-destructive',
        $props.class,
      )
    "
  />
</template>
