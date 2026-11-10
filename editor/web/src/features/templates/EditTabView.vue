<script setup lang="ts">
// =============================================================================
// EditTabView.vue — テンプレ検索タブ (検索 → 一覧 → 編集画面へ遷移)
// =============================================================================
import { type DropdownQuery, isErr, type TemplateMeta } from '@editor/shared';
import { Search } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { buttonVariants } from '@/components/ui/Button.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useLatest } from '@/lib/useLatest';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
import NewBaseDateDialog from './components/NewBaseDateDialog.vue';
import SearchFilters from './components/SearchFilters.vue';
import TemplateTable from './components/TemplateTable.vue';
import { editorRoute, opensAsCreate } from './editorRoute';

const router = useRouter();
const repo = useTemplateRepo();
const history = useHistoryRepo();
const pending = usePendingReviewsStore();
const { run } = useAsyncResult();
// 条件を素早く変えると前の検索の応答が後から届く。表示は最新の検索のものだけへ絞る。
const latestSearch = useLatest();
const rows = ref<TemplateMeta[]>([]);
const versionCounts = ref<Record<string, number>>({});
const searched = ref(false);
// 帳票作成の連携が有効なときだけ「新しい基準日で開く」を出す。状態の取得に失敗したら出さない。
const reportEnabled = ref(false);
const newBaseDateOpen = ref(false);

onMounted(async () => {
  const status = await repo.getReportStatus();
  reportEnabled.value = !isErr(status) && status.value.enabled;
});

async function search(q: DropdownQuery) {
  const isLatest = latestSearch.begin();
  const result = await run(() => repo.listTemplates(q));
  if (isErr(result) || !isLatest()) { return; }
  rows.value = result.value;
  searched.value = true;
  // 版数 = 確定保存の回数(確定版の件数)。比較画面で選べる版は、これに現行版 1 件を足した数。
  const counts: Record<string, number> = {};
  await Promise.all(
    result.value.map(async (m) => {
      const vers = await history.listVersions(m.id);
      counts[m.id] = isErr(vers) ? 0 : vers.value.length;
    }),
  );
  if (!isLatest()) { return; }
  versionCounts.value = counts;
}

function openEditor(m: TemplateMeta) {
  router.push(editorRoute(m.id, { created: opensAsCreate(m) }));
}

/** 「承認待ち」バッジ。承認タブをそのテンプレートで開く(件数に関わらず同じ導線)。 */
function openReview(m: TemplateMeta) {
  router.push({ name: 'reviews', query: { template: m.id } });
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-bold">テンプレートを検索</h2>
    <button
      v-if="reportEnabled"
      type="button"
      :class="buttonVariants({ variant: 'outline', size: 'sm' })"
      @click="newBaseDateOpen = true"
    >
      新しい基準日で開く
    </button>
    <NewBaseDateDialog v-if="reportEnabled" v-model:open="newBaseDateOpen" />
    <SearchFilters dropdown-scope="edit" @search="search" @restore="search" />
    <TemplateTable
      v-if="searched"
      :rows="rows"
      action="edit"
      :version-counts="versionCounts"
      :pending-reviews="pending.byTemplate"
      @action="openEditor"
      @open-review="openReview"
    />
    <EmptyState
      v-else
      :icon="Search"
      title="テンプレートを検索"
      hint="委託会社・ファンド・基準日などの条件を選んで検索してください。"
    />
  </div>
</template>
