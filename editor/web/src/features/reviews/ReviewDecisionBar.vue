<script setup lang="ts">
// =============================================================================
// ReviewDecisionBar.vue — 承認タブの申請カード下端の判定バー
// =============================================================================
// 段階(① パーツを判定する → ② 最終確定する)・判定の進み具合・次の未判定への移動・最終確定を
// 1 本に集める。最終確定の可否は親が決め(`canFinalize`)、押せない理由のうち本文に無い判定などは
// `blockedReasons` として赤字で並べる。保存中・処理中(`busy`)は押せない。
import { computed } from 'vue';
import { type DecisionCounts, finalizeHint } from './reviewDecisionState';

const props = defineProps<{
  counts: DecisionCounts;
  nextNo: number | null;
  blockedReasons: string[];
  canFinalize: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{ next: []; finalize: [] }>();

const decided = computed(() => props.counts.approved + props.counts.rejected);
const pct = (n: number) => (props.counts.total > 0 ? (n / props.counts.total) * 100 : 0);
const hint = computed(() => finalizeHint(props.counts));
const finalizeDisabled = computed(
  () =>
    props.busy ||
    !props.canFinalize ||
    props.counts.pending > 0 ||
    props.blockedReasons.length > 0,
);
</script>

<template>
  <div
    data-decision-bar
    class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/40 px-3 py-2 text-sm"
  >
    <ol class="flex items-center gap-2 whitespace-nowrap text-xs" data-decision-steps>
      <li
        data-step="judge"
        :data-done="counts.pending === 0"
        class="whitespace-nowrap rounded-full border px-2 py-0.5"
        :class="counts.pending === 0 ? 'border-green-600 text-green-700' : 'font-bold'"
      >
        <span v-if="counts.pending === 0">✓ </span>① パーツを判定する
      </li>
      <li aria-hidden="true">→</li>
      <li data-step="finalize" class="whitespace-nowrap rounded-full border px-2 py-0.5">
        ② 最終確定する
      </li>
    </ol>

    <div class="flex min-w-0 flex-1 items-center gap-2" data-decision-progress>
      <span class="whitespace-nowrap text-xs">
        判定 {{ decided }} / {{ counts.total }}　承認 {{ counts.approved }}・却下
        {{ counts.rejected }}・未判定 {{ counts.pending }}
      </span>
      <div class="flex h-2 min-w-16 flex-1 overflow-hidden rounded bg-muted" aria-hidden="true">
        <div class="bg-green-600" :style="{ width: `${pct(counts.approved)}%` }"></div>
        <div class="bg-red-600" :style="{ width: `${pct(counts.rejected)}%` }"></div>
      </div>
    </div>

    <button
      v-if="nextNo !== null"
      type="button"
      data-next-pending
      class="whitespace-nowrap rounded border px-2 py-1 text-xs hover:bg-muted"
      @click="emit('next')"
    >
      次の未判定 {{ nextNo }} へ
    </button>

    <div class="ml-auto flex items-center gap-2">
      <span data-finalize-hint class="text-xs text-muted-foreground">{{ hint }}</span>
      <button
        type="button"
        data-finalize
        class="whitespace-nowrap rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="finalizeDisabled"
        @click="emit('finalize')"
      >
        最終確定する
      </button>
    </div>

    <ul v-if="blockedReasons.length > 0" class="basis-full space-y-0.5 text-xs text-red-600">
      <li v-for="r in blockedReasons" :key="r" data-finalization-issue>{{ r }}</li>
    </ul>
  </div>
</template>
