<script setup lang="ts">
import { type DropdownQuery, type GenerateRequest, isErr, type TemplateMeta } from '@editor/shared';
import { FilePlus2 } from 'lucide-vue-next';
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import BackButton from '@/components/ui/BackButton.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import Label from '@/components/ui/Label.vue';
import { toastError, toastSuccess } from '@/components/ui/toast';
import { useAsyncResult } from '@/lib/useAsyncResult';
import SearchFilters from './components/SearchFilters.vue';
import TemplateTable from './components/TemplateTable.vue';
import {
  SELECT_ALL_MSG,
  useTemplateCreationService,
} from './services/templateCreationService';

const router = useRouter();
const templates = useTemplateCreationService();
const { loading: creating, run } = useAsyncResult();
const liveQuery = reactive<DropdownQuery>({});
const seriesMode = ref(false);
const seriesRows = ref<TemplateMeta[]>([]);

const canCreate = computed(
  () => !!liveQuery.companyCode && !!liveQuery.fundCode && !!liveQuery.editionType,
);

function onUpdate(q: DropdownQuery) {
  Object.assign(liveQuery, q);
}

function onSearch(q: DropdownQuery) {
  Object.assign(liveQuery, q);
  if (seriesMode.value) loadSeries();
}

async function loadSeries() {
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  const res = await run(() =>
    templates.listSeriesFunds(companyCode, fundCode, editionType),
  );
  if (isErr(res)) return;
  seriesRows.value = res.value;
}

async function create(req: GenerateRequest, successMsg: string) {
  const res = await run(() => templates.create(req));
  if (isErr(res)) return;
  toastSuccess(successMsg);
  router.push({ name: 'editor', params: { id: res.value.id } });
}

function createNew() {
  const { companyCode, fundCode, editionType } = liveQuery;
  if (!companyCode || !fundCode || !editionType) {
    toastError(SELECT_ALL_MSG);
    return;
  }
  create({ companyCode, fundCode, editionType }, 'テンプレートを作成しました');
}

function createFromSeries(m: TemplateMeta) {
  create(
    {
      companyCode: m.attributes.companyCode,
      fundCode: m.attributes.fundCode,
      editionType: m.attributes.editionType,
      basedOnTemplateId: m.id,
    },
    'シリーズファンドを基にテンプレートを作成しました',
  );
}

function toggleSeries(v: boolean) {
  seriesMode.value = v;
  if (v) loadSeries();
  else seriesRows.value = [];
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3">
      <BackButton :fallback="{ name: 'edit' }" label="ホーム" />
      <h2 class="text-lg font-semibold">テンプレート作成</h2>
    </div>
    <SearchFilters
      :fields="['companyCode', 'fundCode', 'editionType']"
      :required-fields="['companyCode', 'fundCode', 'editionType']"
      search-label="絞り込み"
      @search="onSearch"
      @update="onUpdate"
    />

    <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
      <div class="flex items-center gap-2">
        <Checkbox id="series" :model-value="seriesMode" @update:model-value="(v) => toggleSeries(!!v)" />
        <Label for="series">既存のシリーズファンドを元に作成する</Label>
      </div>
      <div v-if="!seriesMode" class="flex flex-col items-end gap-1">
        <Button :disabled="creating || !canCreate" @click="createNew">
          <FilePlus2 class="h-4 w-4" /> {{ creating ? '作成中…' : '新規作成' }}
        </Button>
        <p v-if="!canCreate" class="text-xs text-muted-foreground">
          委託会社・ファンド・版種をすべて選択してください
        </p>
      </div>
    </div>

    <template v-if="seriesMode">
      <h3 class="text-sm font-semibold">元にするシリーズファンドを選択</h3>
      <p class="text-sm text-muted-foreground">
        各行の「作成」を押すと、そのファンドを基にした編集画面に進みます
      </p>
      <TemplateTable :rows="seriesRows" action="create" @action="createFromSeries" />
    </template>
  </div>
</template>
