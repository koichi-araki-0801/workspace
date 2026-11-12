<script setup lang="ts">
// =============================================================================
// SearchFilters.vue — 委託会社→ファンド→基準日→版種のカスケード絞り込みバー
// =============================================================================
import { type DropdownOptions, type DropdownQuery, type DropdownScope, isOk } from '@editor/shared';
import { Loader2, RotateCcw, Search } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useTemplateRepo } from '@/api/repositories';
import BaseDateInput from '@/components/ui/BaseDateInput.vue';
import Button from '@/components/ui/Button.vue';
import Combobox from '@/components/ui/Combobox.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FormField from '@/components/ui/FormField.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { findBaseDateCandidate } from '@/lib/baseDate';
import { useCascadingSelect } from '@/lib/useCascadingSelect';
import { useRep1Names } from '@/lib/useRep1Names';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';
import { canSubmitSearch } from './searchGuard';

type Field = 'companyCode' | 'fundCode' | 'baseDate' | 'editionType';

// カスケードの段(左から右へ絞り込む順)。
const FIELDS: Field[] = ['companyCode', 'fundCode', 'baseDate', 'editionType'];

const props = withDefaults(
  defineProps<{
    /** 候補の出所(edit = 編集タブ / published = 比較・結合)。 */
    dropdownScope: DropdownScope;
    searchLabel?: string;
    /** 枠線つき card の装飾を外す (例 step card 内に埋め込むとき)。 */
    bare?: boolean;
    /** 検索/クリアボタンをフィールド行の下 (2 行目) へ折り返す。`field-trailing`
     *  スロットを版種の右に置く比較画面で、横幅を空けるために使う。 */
    stackActions?: boolean;
    /** URL クエリ同期の名前空間。同一ルートに複数置く比較 A/B で衝突回避に渡す
     *  (例 'a'/'b')。未指定なら無接頭辞 (単一インスタンスの編集/作成タブ)。 */
    queryKey?: string;
    /** 候補に無い基準日を確定したときの扱い。`allow` は版種の段へ進め、`reject` は案内を出して
     *  版種の段と検索を止める(候補に無い日付のまま検索すると空の一覧に進むため)。 */
    newBaseDate?: 'allow' | 'reject';
    /** `reject` で候補に無い基準日を確定したときの案内。 */
    unknownDateText?: string;
  }>(),
  {
    searchLabel: '検索',
    bare: false,
    stackActions: false,
    queryKey: undefined,
    newBaseDate: 'reject',
    unknownDateText: 'この基準日の承認済みテンプレートはありません',
  },
);

const emit = defineEmits<{ search: [DropdownQuery]; update: [DropdownQuery]; restore: [DropdownQuery] }>();

const repo = useTemplateRepo();

const labels: Record<Field, string> = {
  companyCode: '委託会社',
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

// 候補を 1 度も取れていない間は options が空なので、基準日が候補にあるかを判定しない
// (取得の失敗でも、候補に無い日付だと誤って案内しない)。
const loaded = ref(false);

const { query, options, loading, onLevelChange, reset, refresh } = useCascadingSelect<
  DropdownQuery,
  DropdownOptions
>({
  levels: FIELDS,
  emptyOptions: EMPTY,
  fetchOptions: async (q) => {
    const res = await repo.getDropdownOptions(q, props.dropdownScope);
    if (isOk(res)) {
      loaded.value = true;
    }
    return res;
  },
  onChange: (q) => emit('update', q),
  immediate: false,
});

const NO_EDITION_TEXT = '作成済みのテンプレートがありません。先に作成タブで作成してください';

// 確定済みの基準日が候補に無い(= 新しい基準日)か。
const unknownDate = computed(
  () =>
    loaded.value &&
    !!query.baseDate &&
    findBaseDateCandidate(query.baseDate, options.value.baseDates) === undefined,
);
const blocked = computed(() => unknownDate.value && props.newBaseDate === 'reject');

// 基準日の段の下に出す案内。版種の候補 0 件は取り直しの途中だと古い候補を見てしまうので待つ。
const baseDateNotice = computed(() => {
  if (blocked.value) {
    return props.unknownDateText;
  }
  if (unknownDate.value && !loading.value && options.value.editionTypes.length === 0) {
    return NO_EDITION_TEXT;
  }
  return '';
});

// URL クエリ同期。hydrate は setup 同期で効くので, 下の refresh は復元済み query で options を
// 取る。`restore` は候補を取り終えてから出す。先に出すと、URL に残った候補に無い基準日のまま
// 親が検索してしまう。
const { hydrated } = useUrlQuerySync(query, { keys: FIELDS, prefix: props.queryKey });
onMounted(async () => {
  await refresh();
  if (hydrated && !blocked.value) {
    emit('restore', { ...query });
  }
});

const { resolveCompanies, resolveFunds, companyLabel, fundName } = useRep1Names();
resolveCompanies();
watch(
  () => query.companyCode,
  (c) => c && resolveFunds(c),
  { immediate: true },
);

// 委託会社は「略称（コード）」、ファンドは「コード 名称」をラベルに。value は略称・コードの
// まま(query/cascade 不変)。名前は Rep1 から引く(`useRep1Names`)。
const companyOptions = computed(() =>
  options.value.companyCodes.map((code) => ({ label: companyLabel(code), value: code })),
);
const fundOptions = computed(() =>
  options.value.fundCodes.map((code) => {
    const name = query.companyCode ? fundName(query.companyCode, code) : '';
    return { label: name ? `${code} ${name}` : code, value: code };
  }),
);

type Option = string | { label: string; value: string };
const optionsByField: Record<Field, () => Option[]> = {
  companyCode: () => companyOptions.value,
  fundCode: () => fundOptions.value,
  baseDate: () => options.value.baseDates,
  editionType: () => options.value.editionTypes,
};

// コード系フィールドは入力で前方一致フィルタする `Combobox` にする。版種は候補が少なく
// 入力の旨味が薄いので `Select` のまま。基準日は候補に無い日付も打ち込める `BaseDateInput`。
const COMBO_FIELDS: Field[] = ['companyCode', 'fundCode'];

// カスケード非活性: 左隣のフィールドが未選択なら、この段はまだ選べない。
function fieldDisabled(f: Field): boolean {
  const idx = FIELDS.indexOf(f);
  if (idx === 0) { return false; // 先頭 (委託会社) は常に活性
}
  if (f === 'editionType' && blocked.value) {
    return true;
  }
  return !query[FIELDS[idx - 1]];
}

// 検索ボタンの活性。条件が空のまま押しても結果も案内も出ないので、押せないことを
// 見た目で示す (判定は `searchGuard.ts`)。
const canSearch = computed(() => !blocked.value && canSubmitSearch(query, FIELDS));
</script>

<template>
  <FilterBar :bare="props.bare">
    <FormField v-for="f in FIELDS" :key="f" width="2xl">
      <Label>
        {{ labels[f] }}
      </Label>
      <!-- コード系は `Combobox`、基準日は `BaseDateInput`、版種は `Select`。
           props/イベントは三者同一なので、カスケードの配線(onLevelChange)は不変。 -->
      <Combobox
        v-if="COMBO_FIELDS.includes(f)"
        v-model="query[f]"
        :options="optionsByField[f]()"
        :placeholder="`${labels[f]}を入力/選択`"
        :disabled="loading || fieldDisabled(f)"
        @update:model-value="onLevelChange(f)"
      />
      <template v-else-if="f === 'baseDate'">
        <BaseDateInput
          v-model="query[f]"
          :options="optionsByField[f]()"
          :placeholder="`${labels[f]}を入力/選択`"
          :disabled="loading || fieldDisabled(f)"
          @update:model-value="onLevelChange(f)"
        />
        <p v-if="baseDateNotice" role="status" class="text-xs text-muted-foreground">
          {{ baseDateNotice }}
        </p>
      </template>
      <Select
        v-else
        v-model="query[f]"
        :options="optionsByField[f]()"
        :placeholder="`${labels[f]}を選択`"
        :disabled="loading || fieldDisabled(f)"
        @update:model-value="onLevelChange(f)"
      />
    </FormField>
    <!-- 版種の右に追加要素を差し込むスロット (比較画面の「現在の比較する版」表示)。 -->
    <slot name="field-trailing" />
    <!-- `stackActions` 時は `basis-full` でボタン群だけ次行へ折り返す。 -->
    <div class="flex items-center gap-2" :class="props.stackActions ? 'basis-full' : ''">
      <Loader2 v-if="loading" class="h-4 w-4 animate-spin text-muted-foreground" />
      <Button :disabled="!canSearch" @click="emit('search', { ...query })">
        <Search class="h-4 w-4" /> {{ props.searchLabel }}
      </Button>
      <Button variant="outline" @click="reset">
        <RotateCcw class="h-4 w-4" /> クリア
      </Button>
    </div>
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </FilterBar>
</template>
