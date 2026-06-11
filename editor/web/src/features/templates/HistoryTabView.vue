<script setup lang="ts">
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

// One filter shared across types, so 実行者/期間/キーワード carry over when switching.
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

const FONT_MONO = 'font-mono text-xs';
const editColumns: HistoryColumn<EditHistoryEntry>[] = [
  { header: '日時', value: (e) => formatDateTime(e.timestamp) },
  { header: 'テンプレート', cellClass: FONT_MONO, value: (e) => e.templateId },
  { header: '実行者', value: (e) => e.user },
  { header: '内容', value: (e) => e.summary },
];
const pdfColumns: HistoryColumn<PdfHistoryEntry>[] = [
  { header: '日時', value: (e) => formatDateTime(e.timestamp) },
  { header: 'テンプレート', cellClass: FONT_MONO, value: (e) => e.templateId },
  { header: '実行者', value: (e) => e.user },
];
const createColumns: HistoryColumn<CreateHistoryEntry>[] = [
  { header: '日時', value: (e) => formatDateTime(e.timestamp) },
  { header: '生成ファイル', cellClass: FONT_MONO, value: (e) => templateFileName(e.attributes) },
  { header: '実行者', value: (e) => e.user },
  { header: '元テンプレート', cellClass: FONT_MONO, value: (e) => e.basedOnTemplateId ?? '—' },
];

// Values fed to the single filter bar, switched by the active history type.
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
    <h2 class="text-lg font-semibold">履歴</h2>

    <HistoryFilters v-model="filter" :users="activeUsers" :keyword-label="activeKeywordLabel">
      <template #lead>
        <div class="inline-flex rounded-md border p-0.5">
          <button
            v-for="t in TYPES"
            :key="t.value"
            type="button"
            :aria-pressed="type === t.value"
            :class="
              cn(
                'rounded px-3 py-1 text-sm font-medium transition-colors',
                type === t.value
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            "
            @click="type = t.value"
          >
            {{ t.label }}
          </button>
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
