<script setup lang="ts">
// =============================================================================
// HistoryTabView.vue — 履歴タブ (編集/PDF/作成を 1 つのフィルタバーで切替表示)
// =============================================================================
import {
  type CreateHistoryEntry,
  type EditHistoryEntry,
  isErr,
  matchFilter,
  type PdfHistoryEntry,
  templateFileName,
  uniq,
} from '@editor/shared';
import { computed, onMounted, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import { formatDateTime } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { usePagedList } from '@/lib/usePagedList';
import { cn } from '@/lib/utils';
import HistoryFilters, { type HistoryFilter } from './components/HistoryFilters.vue';
import HistoryTable, { type HistoryColumn } from './components/HistoryTable.vue';
import { useHistoryService } from './services/historyService';

const history = useHistoryService();
const { run } = useAsyncResult();

type HistoryType = 'edit' | 'pdf' | 'create';
const TYPES: { value: HistoryType; label: string }[] = [
  { value: 'edit', label: '編集履歴' },
  { value: 'pdf', label: 'PDF出力履歴' },
  { value: 'create', label: '作成履歴' },
];

const type = ref<HistoryType>('edit');
const loading = ref(true);
const edits = ref<EditHistoryEntry[]>([]);
const pdfs = ref<PdfHistoryEntry[]>([]);
const creates = ref<CreateHistoryEntry[]>([]);

// フィルタは全タイプで共有する。切替時も 実行者/期間/キーワード を引き継ぐため。
const filter = ref<HistoryFilter>({});

const editUsers = computed(() => uniq(edits.value.map((e) => e.user)));
const pdfUsers = computed(() => uniq(pdfs.value.map((e) => e.user)));
const createUsers = computed(() => uniq(creates.value.map((e) => e.user)));

const filteredEdits = computed(() =>
  edits.value.filter((e) => matchFilter(e, filter.value, [e.templateId, e.summary])),
);
const filteredPdfs = computed(() =>
  pdfs.value.filter((e) => matchFilter(e, filter.value, [e.templateId])),
);
const filteredCreates = computed(() =>
  creates.value.filter((e) => matchFilter(e, filter.value, [templateFileName(e.attributes)])),
);

const pagedEdits = usePagedList(filteredEdits);
const pagedPdfs = usePagedList(filteredPdfs);
const pagedCreates = usePagedList(filteredCreates);

const MONO = 'mono text-xs';
// 共通幅。履歴タブ切替時に列が揃うようにする (table-fixed レイアウト)。
const W_TIME = 'w-[180px]';
const W_ID = 'w-[260px]';
const W_USER = 'w-[140px]';
const editColumns: HistoryColumn<EditHistoryEntry>[] = [
  { header: '日時', headerClass: W_TIME, cellClass: MONO, value: (e) => formatDateTime(e.timestamp) },
  { header: 'テンプレート', headerClass: W_ID, cellClass: MONO, value: (e) => e.templateId },
  { header: '実行者', headerClass: W_USER, value: (e) => e.user },
  { header: '内容', value: (e) => e.summary },
];
const pdfColumns: HistoryColumn<PdfHistoryEntry>[] = [
  { header: '日時', headerClass: W_TIME, cellClass: MONO, value: (e) => formatDateTime(e.timestamp) },
  { header: 'テンプレート', headerClass: W_ID, cellClass: MONO, value: (e) => e.templateId },
  { header: '実行者', value: (e) => e.user },
];
const createColumns: HistoryColumn<CreateHistoryEntry>[] = [
  { header: '日時', headerClass: W_TIME, cellClass: MONO, value: (e) => formatDateTime(e.timestamp) },
  { header: '生成ファイル', headerClass: W_ID, cellClass: MONO, value: (e) => templateFileName(e.attributes) },
  { header: '実行者', headerClass: W_USER, value: (e) => e.user },
  { header: '元テンプレート', cellClass: MONO, value: (e) => e.basedOnTemplateId ?? '—' },
];

// 単一のフィルタバーへ渡す値。アクティブな履歴タイプに応じて切り替える。
const activeUsers = computed(() =>
  type.value === 'pdf' ? pdfUsers.value : type.value === 'create' ? createUsers.value : editUsers.value,
);
const activeKeywordLabel = computed(() => (type.value === 'create' ? 'ファイル名' : 'テンプレート'));

onMounted(async () => {
  const res = await run(() => history.loadAll());
  if (!isErr(res)) {
    edits.value = res.value.edits;
    pdfs.value = res.value.pdfs;
    creates.value = res.value.creates;
  }
  loading.value = false;
});
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-bold">履歴</h2>

    <HistoryFilters v-model="filter" :users="activeUsers" :keyword-label="activeKeywordLabel">
      <template #lead>
        <div class="inline-flex rounded-md border p-0.5">
          <Button
            v-for="t in TYPES"
            :key="t.value"
            variant="ghost"
            :aria-pressed="type === t.value"
            :class="
              cn(
                'h-auto rounded px-3 py-1',
                type === t.value
                  ? 'bg-primary-soft text-primary hover:bg-primary-soft hover:text-primary'
                  : 'text-muted-foreground',
              )
            "
            @click="type = t.value"
          >
            {{ t.label }}
          </Button>
        </div>
      </template>
    </HistoryFilters>

    <HistoryTable
      v-if="type === 'edit'"
      :columns="editColumns"
      :rows="pagedEdits.visible"
      :empty="filteredEdits.length === 0"
      :has-more="pagedEdits.hasMore"
      :remaining="pagedEdits.remaining"
      :loading="loading"
      @load-more="pagedEdits.loadMore()"
    />
    <HistoryTable
      v-else-if="type === 'pdf'"
      :columns="pdfColumns"
      :rows="pagedPdfs.visible"
      :empty="filteredPdfs.length === 0"
      :has-more="pagedPdfs.hasMore"
      :remaining="pagedPdfs.remaining"
      :loading="loading"
      @load-more="pagedPdfs.loadMore()"
    />
    <HistoryTable
      v-else
      :columns="createColumns"
      :rows="pagedCreates.visible"
      :empty="filteredCreates.length === 0"
      :has-more="pagedCreates.hasMore"
      :remaining="pagedCreates.remaining"
      :loading="loading"
      @load-more="pagedCreates.loadMore()"
    />
  </div>
</template>
