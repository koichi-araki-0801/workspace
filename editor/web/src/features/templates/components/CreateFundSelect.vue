<script setup lang="ts">
// =============================================================================
// CreateFundSelect.vue — 作成タブ Step 1 の連動プルダウン(委託会社 → ファンド → 版種)
// =============================================================================
// 候補は Rep1 のファンド属性(サーバの sproc 経由)から取る。会社は開いたとき、ファンドは会社を
// 選んだときに一括取得する。会社の値はファイル名の会社コード(略称)で、ファンドを引くときだけ
// Rep1 の会社コードを使う。見た目は編集タブの `SearchFilters` と同じ部品で組む。
import { type CompanyOption, type FundOption, isErr } from '@editor/shared';
import { Loader2, RotateCcw } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import Combobox from '@/components/ui/Combobox.vue';
import FilterBar from '@/components/ui/FilterBar.vue';
import FormField from '@/components/ui/FormField.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { toastError } from '@/components/ui/toast';
import { useLatest } from '@/lib/useLatest';
import { useUrlQuerySync } from '@/lib/useUrlQuerySync';
import { useTemplateCreationService } from '../services/templateCreationService';

/** 作成タブで選べる版種。 */
const EDITION_TYPES = ['交付版', '全体版'];

export interface CreateFundSelection {
  companyCode?: string;
  rep1CompanyCode?: string;
  fundCode?: string;
  editionType?: string;
}

const emit = defineEmits<{ update: [CreateFundSelection] }>();

const service = useTemplateCreationService();
const query = reactive<{ companyCode?: string; fundCode?: string; editionType?: string }>({});
const companies = ref<CompanyOption[]>([]);
const funds = ref<FundOption[]>([]);
const loading = ref(false);
const latestFunds = useLatest();

useUrlQuerySync(query, { keys: ['companyCode', 'fundCode', 'editionType'] });

const rep1Of = (companyCode?: string) =>
  companies.value.find((c) => c.companyCode === companyCode)?.rep1CompanyCode;
const companyOptions = computed(() =>
  companies.value.map((c) => ({ label: c.companyName, value: c.companyCode })),
);
const fundOptions = computed(() =>
  funds.value.map((f) => ({ label: `${f.fundCode} ${f.fundName}`, value: f.fundCode })),
);

function notify() {
  emit('update', { ...query, rep1CompanyCode: rep1Of(query.companyCode) });
}

/** 会社のファンドを引く。`keepFund` は URL から復元した選択を残すとき。 */
async function loadFunds(keepFund: boolean) {
  const rep1 = rep1Of(query.companyCode);
  funds.value = [];
  if (!keepFund) {
    query.fundCode = undefined;
    query.editionType = undefined;
  }
  if (!rep1) {
    notify();
    return;
  }
  const isLatest = latestFunds.begin();
  loading.value = true;
  const res = await service.listFunds(rep1);
  if (!isLatest()) return;
  loading.value = false;
  if (isErr(res)) {
    toastError(res.error.message);
    return;
  }
  funds.value = res.value;
  notify();
}

onMounted(async () => {
  loading.value = true;
  const res = await service.listCompanies();
  loading.value = false;
  if (isErr(res)) {
    toastError(res.error.message);
    return;
  }
  companies.value = res.value;
  await loadFunds(true);
});

function onCompany() {
  void loadFunds(false);
}

function onFund() {
  query.editionType = undefined;
  notify();
}

function reset() {
  query.companyCode = undefined;
  query.fundCode = undefined;
  query.editionType = undefined;
  funds.value = [];
  notify();
}
</script>

<template>
  <FilterBar bare>
    <FormField width="2xl">
      <Label>委託会社 <span class="text-destructive">*</span></Label>
      <!-- 表示名は候補から引くので、URL から復元した値に候補が後から届いたら作り直して出し直す。 -->
      <Combobox
        :key="`company-${companyOptions.length}`"
        v-model="query.companyCode"
        :options="companyOptions"
        placeholder="委託会社を入力/選択"
        :disabled="loading && companies.length === 0"
        @update:model-value="onCompany"
      />
    </FormField>
    <FormField width="2xl">
      <Label>ファンド <span class="text-destructive">*</span></Label>
      <Combobox
        :key="`fund-${query.companyCode ?? ''}-${fundOptions.length}`"
        v-model="query.fundCode"
        :options="fundOptions"
        placeholder="ファンドを入力/選択"
        :disabled="loading || !query.companyCode"
        @update:model-value="onFund"
      />
    </FormField>
    <FormField width="2xl">
      <Label>版種 <span class="text-destructive">*</span></Label>
      <Select
        v-model="query.editionType"
        :options="EDITION_TYPES"
        placeholder="版種を選択"
        :disabled="!query.fundCode"
        @update:model-value="notify"
      />
    </FormField>
    <div class="flex items-center gap-2">
      <Loader2 v-if="loading" class="h-4 w-4 animate-spin text-muted-foreground" />
      <Button variant="outline" @click="reset"> <RotateCcw class="h-4 w-4" /> クリア </Button>
    </div>
  </FilterBar>
</template>
