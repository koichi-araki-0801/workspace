<script setup lang="ts">
// =============================================================================
// SearchFilters.vue — 委託会社→ファンド→基準日→版種のカスケード絞り込みバー
// =============================================================================
import type { DropdownOptions, DropdownQuery } from '@editor/shared';
import { Loader2, RotateCcw, Search } from '@lucide/vue';
import { computed, onMounted, watch } from 'vue';
import { useTemplateRepo } from '@/api/repositories';
import Button from '@/components/ui/Button.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { useCascadingSelect } from '@/lib/useCascadingSelect';
import { useFundNames } from '@/lib/useFundNames';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';

type Field = 'companyCode' | 'fundCode' | 'baseDate' | 'editionType';

const props = withDefaults(
  defineProps<{
    /** どの属性フィールドをカスケード dropdown として出すか。 */
    fields?: Field[];
    searchLabel?: string;
    /** 必須を示すアスタリスクを付けるフィールド。 */
    requiredFields?: Field[];
    /** 検索ボタンを隠す (例 役割を持たない作成画面)。 */
    hideSearch?: boolean;
    /** 枠線つき card の装飾を外す (例 step card 内に埋め込むとき)。 */
    bare?: boolean;
    /** 検索/クリアボタンをフィールド行の下 (2 行目) へ折り返す。`field-trailing`
     *  スロットを版種の右に置く比較画面で、横幅を空けるために使う。 */
    stackActions?: boolean;
    /** URL クエリ同期の名前空間。同一ルートに複数置く比較 A/B で衝突回避に渡す
     *  (例 'a'/'b')。未指定なら無接頭辞 (単一インスタンスの編集/作成タブ)。 */
    queryKey?: string;
  }>(),
  {
    fields: () => ['companyCode', 'fundCode', 'baseDate', 'editionType'],
    searchLabel: '検索',
    requiredFields: () => [],
    hideSearch: false,
    bare: false,
    stackActions: false,
    queryKey: undefined,
  },
);

const emit = defineEmits<{ search: [DropdownQuery]; update: [DropdownQuery]; restore: [DropdownQuery] }>();

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

// URL クエリ同期。hydrate は setup 同期で効くので, 上の onMounted(refresh) は復元済み
// query で options を取る。復元できたときだけ親へ `restore` を通知し一覧を再取得させる。
const { hydrated } = useUrlQuerySync(query, { keys: props.fields, prefix: props.queryKey });
onMounted(() => {
  if (hydrated) emit('restore', { ...query });
});

const { resolve, nameOf } = useFundNames();
watch(() => options.value.fundCodes, (codes) => resolve(codes), { immediate: true });

// ファンドコードはコード+名称をラベルに、value はコードのまま (query/cascade 不変)。
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
  if (idx === 0) return false; // 先頭 (委託会社) は常に活性
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
      <!-- 版種の右に追加要素を差し込むスロット (比較画面の「現在の比較する版」表示)。 -->
      <slot name="field-trailing" />
      <!-- `stackActions` 時は `basis-full` でボタン群だけ次行へ折り返す。 -->
      <div class="flex items-center gap-2" :class="props.stackActions ? 'basis-full' : ''">
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
