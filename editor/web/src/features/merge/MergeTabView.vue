<script setup lang="ts">
// =============================================================================
// MergeTabView.vue — 結合PDF タブ (検索 → 追加 → 並び替え → 1 PDF 出力)
// =============================================================================
// 複数の登録済みテンプレを選択リストへ集め、選んだ順序のまま通しページ番号付きの
// 1 つの PDF に結合する。検索・一覧は編集タブと同じ部品を流用し、このタブ固有の
// 状態は「選択リストとその順序」だけに保つ。
import { type DropdownQuery, isErr, type TemplateMeta } from '@editor/shared';
import { FileDown, Loader2, Search } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useTemplateRepo } from '@/api/repositories';
import Button from '@/components/ui/Button.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { toastSuccess } from '@/components/ui/toast';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useSlowIndicator } from '@/lib/useSlowIndicator';
import SearchFilters from '../templates/components/SearchFilters.vue';
import TemplateTable from '../templates/components/TemplateTable.vue';
import MergeSelectionList from './components/MergeSelectionList.vue';
import { useMergePdfService } from './services/mergePdfService';

const repo = useTemplateRepo();
const mergeService = useMergePdfService();
const { run } = useAsyncResult();

const rows = ref<TemplateMeta[]>([]);
const searched = ref(false);
const selection = ref<TemplateMeta[]>([]);

// 選択済みは検索結果から除外する(重複追加の防止。行 disabled 対応より単純で見た目も明快)。
const candidates = computed(() => {
  const chosen = new Set(selection.value.map((m) => m.id));
  return rows.value.filter((m) => !chosen.has(m.id));
});

async function search(q: DropdownQuery) {
  const result = await run(() => repo.listTemplates(q));
  if (isErr(result)) return;
  rows.value = result.value;
  searched.value = true;
}

function add(m: TemplateMeta) {
  selection.value = [...selection.value, m];
}

function move(index: number, dir: -1 | 1) {
  const next = [...selection.value];
  const [item] = next.splice(index, 1);
  next.splice(index + dir, 0, item);
  selection.value = next;
}

function remove(index: number) {
  selection.value = selection.value.filter((_, i) => i !== index);
}

// ── PDF 出力 ──

const exporting = ref(false);
const { slow: exportSlow } = useSlowIndicator(exporting);
const progress = ref<{ done: number; total: number } | null>(null);

/** 進捗表示の文言。レンダ中は n/m、全件レンダ後(サーバ組版待ち)は生成中表示へ切り替える。 */
const progressLabel = computed(() => {
  const p = progress.value;
  if (!p) return '';
  if (p.done < p.total) return `${p.done + 1}/${p.total} 件目をレンダリング中…`;
  return 'PDF を生成しています…';
});

async function exportPdf() {
  if (selection.value.length === 0 || exporting.value) return;
  exporting.value = true;
  progress.value = { done: 0, total: selection.value.length };
  try {
    const ids = selection.value.map((m) => m.id);
    const result = await run(() =>
      mergeService.renderMergedPdf(ids, (done, total) => {
        progress.value = { done, total };
      }),
    );
    if (isErr(result)) return;
    // ブラウザ標準のダウンロードへ流す(プレビュー画面の単体 PDF 出力と同じ UX)。
    const url = URL.createObjectURL(result.value);
    const a = document.createElement('a');
    a.href = url;
    a.download = `merged-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toastSuccess('PDFのダウンロードを開始しました');
  } finally {
    exporting.value = false;
    progress.value = null;
  }
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-bold">結合PDFを作成</h2>
    <p class="text-sm text-muted-foreground">
      テンプレートを検索して結合したい順に追加すると、通しページ番号付きの 1 つの PDF を出力できます。
    </p>
    <SearchFilters @search="search" @restore="search" />

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div class="min-w-0">
        <TemplateTable v-if="searched" :rows="candidates" action="add" @action="add" />
        <EmptyState
          v-else
          :icon="Search"
          title="テンプレートを検索"
          hint="委託会社・ファンド・基準日などの条件を選んで検索してください。"
        />
      </div>

      <div class="space-y-3">
        <MergeSelectionList :items="selection" @move="move" @remove="remove" />
        <Button class="w-full" :disabled="selection.length === 0 || exporting" @click="exportPdf">
          <Loader2 v-if="exporting" class="h-4 w-4 animate-spin" />
          <FileDown v-else class="h-4 w-4" />
          {{ exporting ? progressLabel || 'PDF を生成しています…' : 'PDF 出力' }}
        </Button>
        <p v-if="exporting && exportSlow" class="text-center text-xs text-muted-foreground">
          結合する件数によっては 1 分ほどかかることがあります。
        </p>
      </div>
    </div>
  </div>
</template>
