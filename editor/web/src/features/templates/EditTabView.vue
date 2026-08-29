<script setup lang="ts">
// =============================================================================
// EditTabView.vue — テンプレ検索タブ (検索 → 一覧 → 編集画面へ遷移)
// =============================================================================
import { type DropdownQuery, isErr, type TemplateMeta } from '@editor/shared';
import { Search } from '@lucide/vue';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useLatest } from '@/lib/useLatest';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
import SearchFilters from './components/SearchFilters.vue';
import TemplateTable from './components/TemplateTable.vue';

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

async function search(q: DropdownQuery) {
  const isLatest = latestSearch.begin();
  const result = await run(() => repo.listTemplates(q));
  if (isErr(result) || !isLatest()) return;
  rows.value = result.value;
  searched.value = true;
  // 版数 (確定保存回数) を各テンプレについて集計する (比較画面と同じ計数)。
  const counts: Record<string, number> = {};
  await Promise.all(
    result.value.map(async (m) => {
      const vers = await history.listVersions(m.id);
      counts[m.id] = isErr(vers) ? 0 : vers.value.length;
    }),
  );
  if (!isLatest()) return;
  versionCounts.value = counts;
}

function openEditor(m: TemplateMeta) {
  router.push({ name: 'editor', params: { id: m.id } });
}

/** 「承認待ち」バッジ。1 件ならその精査画面へ直行、複数ならキューで選ばせる。 */
function openReview(m: TemplateMeta) {
  const list = pending.byTemplate[m.id] ?? [];
  if (list.length === 1) router.push({ name: 'review-detail', params: { reqId: list[0].id } });
  else router.push({ name: 'reviews' });
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-bold">テンプレートを検索</h2>
    <SearchFilters @search="search" @restore="search" />
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
