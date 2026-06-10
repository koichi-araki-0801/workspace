<script setup lang="ts">
import type { HistoryFilter } from '@editor/shared';
import { RotateCcw } from '@lucide/vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';

// Per-tab history filter values (matching done by the domain). Re-exported for
// components that import the type alongside this component.
export type { HistoryFilter };

defineProps<{
  /** Distinct operator names for the dropdown (extracted from the displayed data). */
  users: string[];
  /** Label for the tab-specific free-text field (e.g. テンプレ / ファイル名). */
  keywordLabel: string;
}>();

const filter = defineModel<HistoryFilter>({ required: true });

function reset() {
  filter.value = {};
}
</script>

<template>
  <div class="mb-3 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
    <div v-if="$slots.lead" class="w-full"><slot name="lead" /></div>
    <div class="min-w-[160px] flex-1 space-y-1.5">
      <Label>実行者</Label>
      <Select v-model="filter.user" :options="users" placeholder="実行者を選択" />
    </div>
    <div class="min-w-[160px] flex-1 space-y-1.5">
      <Label>{{ keywordLabel }}</Label>
      <Input v-model="filter.keyword" :placeholder="`${keywordLabel}で絞り込み`" />
    </div>
    <div class="min-w-[140px] space-y-1.5">
      <Label>日時（From）</Label>
      <Input v-model="filter.from" type="date" />
    </div>
    <div class="min-w-[140px] space-y-1.5">
      <Label>日時（To）</Label>
      <Input v-model="filter.to" type="date" />
    </div>
    <Button variant="outline" @click="reset">
      <RotateCcw class="h-4 w-4" /> クリア
    </Button>
  </div>
</template>
