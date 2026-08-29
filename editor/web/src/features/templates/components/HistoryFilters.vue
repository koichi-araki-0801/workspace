<script setup lang="ts">
// =============================================================================
// HistoryFilters.vue — 履歴タブ共通のフィルタバー (実行者/キーワード/期間)
// =============================================================================
import type { HistoryFilter } from '@editor/shared';
import { RotateCcw } from '@lucide/vue';
import Button from '@/components/ui/Button.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FormField from '@/components/ui/FormField.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';

// タブごとの履歴フィルタ値 (突き合わせは domain 側が担う)。本コンポーネントと併せて
// 型を import する側のために `HistoryFilter` を re-export する。
export type { HistoryFilter };

defineProps<{
  /** dropdown 用の実行者名 (表示中データから抽出した distinct な値)。 */
  users: string[];
  /** タブ固有の自由入力欄のラベル (例 テンプレ / ファイル名)。 */
  keywordLabel: string;
}>();

const filter = defineModel<HistoryFilter>({ required: true });

function reset() {
  filter.value = {};
}
</script>

<template>
  <FilterBar class="mb-3">
    <div v-if="$slots.lead" class="w-full"><slot name="lead" /></div>
    <FormField width="sm">
      <Label>実行者</Label>
      <Select v-model="filter.user" :options="users" placeholder="実行者を選択" />
    </FormField>
    <FormField width="sm">
      <Label>{{ keywordLabel }}</Label>
      <Input v-model="filter.keyword" :placeholder="`${keywordLabel}で絞り込み`" />
    </FormField>
    <FormField width="xs" :grow="false">
      <Label>日時（From）</Label>
      <Input v-model="filter.from" type="date" />
    </FormField>
    <FormField width="xs" :grow="false">
      <Label>日時（To）</Label>
      <Input v-model="filter.to" type="date" />
    </FormField>
    <Button variant="outline" @click="reset">
      <RotateCcw class="h-4 w-4" /> クリア
    </Button>
  </FilterBar>
</template>
