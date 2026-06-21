<script setup lang="ts">
// =============================================================================
// Step.vue — ガイドカード内の番号付きステップ 1 行
// =============================================================================
import { Check } from '@lucide/vue';
import { computed } from 'vue';

/**
 * ガイドカード内の番号付きステップ 1 行。左に番号バッジ＋縦の connector、右に
 * title/hint/content を並べる。`active`/`done` が配色トーンを決める。
 */
const props = withDefaults(
  defineProps<{
    n: number | string;
    title: string;
    hint?: string;
    active?: boolean;
    done?: boolean;
    /** バッジ下に connector 線を描く(最終ステップでは `false`)。 */
    connector?: boolean;
  }>(),
  { connector: true },
);

const titleColor = computed(() =>
  props.active ? 'text-primary' : props.done ? 'text-success' : 'text-muted-foreground',
);
const badgeClass = computed(() =>
  props.active
    ? 'bg-primary text-primary-foreground'
    : props.done
      ? 'bg-success text-success-foreground'
      : 'bg-muted text-muted-foreground',
);
</script>

<template>
  <div
    class="flex gap-3.5 transition-opacity duration-200"
    :class="active || done ? 'opacity-100' : 'opacity-55'"
  >
    <div class="flex shrink-0 flex-col items-center">
      <div
        class="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold"
        :class="badgeClass"
      >
        <Check v-if="done" class="h-[15px] w-[15px]" />
        <template v-else>{{ n }}</template>
      </div>
      <div v-if="connector" class="mt-1 min-h-2 w-0.5 flex-1 bg-border" />
    </div>
    <div class="min-w-0 flex-1 pb-5">
      <h3 class="text-[14.5px] font-bold" :class="titleColor">{{ title }}</h3>
      <p v-if="hint" class="mb-3 mt-0.5 text-xs leading-relaxed text-muted-foreground">{{ hint }}</p>
      <slot />
    </div>
  </div>
</template>
