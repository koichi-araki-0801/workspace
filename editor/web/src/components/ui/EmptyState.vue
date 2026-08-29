<script setup lang="ts">
// =============================================================================
// EmptyState.vue — 中央寄せの空状態表示(アイコン＋見出し＋ガイド文)
// =============================================================================
import type { FunctionalComponent } from 'vue';

/** 中央寄せの空状態: 角丸アイコンタイル＋見出し＋ガイド文。 */
defineProps<{
  icon: FunctionalComponent;
  title: string;
  hint?: string;
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
    <div class="grid h-16 w-16 place-items-center rounded-2xl bg-primary-soft text-primary">
      <component :is="icon" class="h-7 w-7" />
    </div>
    <h3 class="text-[15px] font-bold text-foreground">{{ title }}</h3>
    <p v-if="hint" class="max-w-sm text-[13px] leading-relaxed text-muted-foreground">{{ hint }}</p>
    <slot />
  </div>
</template>
