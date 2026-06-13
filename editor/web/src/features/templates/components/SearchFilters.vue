<script setup lang="ts">
import type { DropdownOptions, DropdownQuery } from '@editor/shared';
import { Loader2, RotateCcw, Search } from '@lucide/vue';
import { computed, watch } from 'vue';
import { useTemplateRepo } from '@/api/repositories';
import Button from '@/components/ui/Button.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { useCascadingSelect } from '@/lib/useCascadingSelect';
import { useFundNames } from '@/lib/useFundNames';

type Field = 'companyCode' | 'fundCode' | 'baseDate' | 'editionType';

const props = withDefaults(
  defineProps<{
    /** which attribute fields to show as cascading dropdowns */
    fields?: Field[];
    searchLabel?: string;
    /** fields that should be marked with a required asterisk */
    requiredFields?: Field[];
    /** hide the search button (e.g. on the create screen where it has no role) */
    hideSearch?: boolean;
    /** drop the bordered card chrome (e.g. when embedded inside a step card) */
    bare?: boolean;
  }>(),
  {
    fields: () => ['companyCode', 'fundCode', 'baseDate', 'editionType'],
    searchLabel: '検索',
    requiredFields: () => [],
    hideSearch: false,
    bare: false,
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

const { resolve, nameOf } = useFundNames();
watch(() => options.value.fundCodes, (codes) => resolve(codes), { immediate: true });

// ファンドコードはコード＋名称をラベルに、value はコードのまま（クエリ/カスケード不変）。
const fundOptions = computed(() =>
  options.value.fundCodes.map((code) => ({
    label: nameOf(code) ? `${code} ${nameOf(code)}` : code,
    value: code,
  })),
);

type Option = string | { label: string; value: string };
const optionsByField: Record<Field, () => Option[]> = {
  companyCode: () => options.value.companyCodes,
  fundCode: () => fundOptions.value,
  baseDate: () => options.value.baseDates,
  editionType: () => options.value.editionTypes,
};

// カスケード非活性: 左隣のフィールドが未選択なら、この段はまだ選べない。
function fieldDisabled(f: Field): boolean {
  const idx = props.fields.indexOf(f);
  if (idx === 0) return false; // 先頭（委託会社）は常に活性
  return !query[props.fields[idx - 1]];
}
</script>

<template>
  <div :class="props.bare ? '' : 'rounded-lg border bg-card p-4'">
    <div class="flex flex-wrap items-end gap-3">
      <div v-for="f in props.fields" :key="f" class="min-w-[190px] flex-1 space-y-1.5">
        <Label>
          {{ labels[f] }}
          <span v-if="props.requiredFields.includes(f)" class="text-destructive">*</span>
        </Label>
        <Select
          v-model="query[f]"
          :options="optionsByField[f]()"
          :placeholder="`${labels[f]}を選択`"
          :disabled="loading || fieldDisabled(f)"
          @update:model-value="onLevelChange(f)"
        />
      </div>
      <div class="flex items-center gap-2">
        <Loader2 v-if="loading" class="h-4 w-4 animate-spin text-muted-foreground" />
        <Button v-if="!props.hideSearch" @click="emit('search', { ...query })">
          <Search class="h-4 w-4" /> {{ props.searchLabel }}
        </Button>
        <Button variant="outline" @click="reset">
          <RotateCcw class="h-4 w-4" /> クリア
        </Button>
      </div>
    </div>
    <div v-if="$slots.footer" class="mt-4 border-t pt-4">
      <slot name="footer" />
    </div>
  </div>
</template>
