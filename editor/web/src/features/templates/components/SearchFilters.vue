<script setup lang="ts">
import type { DropdownOptions, DropdownQuery } from '@editor/shared';
import { Loader2, RotateCcw, Search } from '@lucide/vue';
import { useTemplateRepo } from '@/api/repositories';
import Button from '@/components/ui/Button.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { useCascadingSelect } from '@/lib/useCascadingSelect';

type Field = 'companyCode' | 'fundCode' | 'baseDate' | 'editionType';

const props = withDefaults(
  defineProps<{
    /** which attribute fields to show as cascading dropdowns */
    fields?: Field[];
    searchLabel?: string;
    /** fields that should be marked with a required asterisk */
    requiredFields?: Field[];
  }>(),
  {
    fields: () => ['companyCode', 'fundCode', 'baseDate', 'editionType'],
    searchLabel: '検索',
    requiredFields: () => [],
  },
);

const emit = defineEmits<{ search: [DropdownQuery]; update: [DropdownQuery] }>();

const repo = useTemplateRepo();

const labels: Record<Field, string> = {
  companyCode: '委託会社コード',
  fundCode: 'ファンドコード',
  baseDate: '基準日',
  editionType: '版種',
};

const EMPTY: DropdownOptions = {
  companyCodes: [],
  fundCodes: [],
  baseDates: [],
  editionTypes: [],
};

const { query, options, loading, onLevelChange, reset } = useCascadingSelect<
  DropdownQuery,
  DropdownOptions
>({
  levels: props.fields,
  emptyOptions: EMPTY,
  fetchOptions: (q) => repo.getDropdownOptions(q),
  onChange: (q) => emit('update', q),
});

const optionsByField: Record<Field, () => string[]> = {
  companyCode: () => options.value.companyCodes,
  fundCode: () => options.value.fundCodes,
  baseDate: () => options.value.baseDates,
  editionType: () => options.value.editionTypes,
};
</script>

<template>
  <div class="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
    <div v-for="f in props.fields" :key="f" class="min-w-[160px] flex-1 space-y-1.5">
      <Label>
        {{ labels[f] }}
        <span v-if="props.requiredFields.includes(f)" class="text-destructive">*</span>
      </Label>
      <Select
        v-model="query[f]"
        :options="optionsByField[f]()"
        :placeholder="`${labels[f]}を選択`"
        :disabled="loading"
        @update:model-value="onLevelChange(f)"
      />
    </div>
    <div class="flex items-center gap-2">
      <Loader2 v-if="loading" class="h-4 w-4 animate-spin text-muted-foreground" />
      <Button @click="emit('search', { ...query })">
        <Search class="h-4 w-4" /> {{ props.searchLabel }}
      </Button>
      <Button variant="outline" @click="reset">
        <RotateCcw class="h-4 w-4" /> クリア
      </Button>
    </div>
  </div>
</template>
