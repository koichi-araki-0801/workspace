<script setup lang="ts">
// =============================================================================
// EditTabView.vue — テンプレ検索タブ (検索 → 一覧 → 編集画面へ遷移)
// =============================================================================
import {
  type DropdownQuery,
  GENERATE_QUEUE_FULL,
  isEditor,
  isErr,
  REPORT_COMPANY_UNKNOWN,
  REPORT_TIMEOUT,
  type TemplateMeta,
  templateFileName,
  templateIdFromFileName,
} from '@editor/shared';
import { FilePlus, Search } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { buttonVariants } from '@/components/ui/Button.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useLatest } from '@/lib/useLatest';
import { useAuthStore } from '@/stores/auth';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
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
// 帳票作成の連携が有効なときだけ、0 件の検索に「作成して開く」を出す。状態の取得に失敗したら
// 出さない。
const reportEnabled = ref(false);
// 値入り HTML の生成は編集者以上(サーバの `requireEditor`)なので、閲覧者には入口を出さない。
// 利用者の取得が済むまでは出さない(取得中は利用者が空で、閲覧者にも一瞬出てしまう)。取得後に
// 利用者が居ないのは無認証モード(サーバがロールを見ない)なので、出す側にする。
const auth = useAuthStore();
const canFill = computed(() => auth.ready && (auth.user === null || isEditor(auth.user)));

onMounted(async () => {
  const status = await repo.getReportStatus();
  reportEnabled.value = !isErr(status) && status.value.enabled;
});

// 連携が有効で生成できる利用者なら、候補に無い基準日も検索欄で確定させる(作って開くため)。
const newBaseDate = computed(() => (reportEnabled.value && canFill.value ? 'allow' : 'reject'));
const UNKNOWN_DATE_TEXT = 'この基準日のテンプレートはありません';

/** 失敗の `code` ごとの利用者向け文言。ここに無い `code` は server の `message` をそのまま出す。 */
const FAILURE_TEXT: Record<string, string> = {
  [GENERATE_QUEUE_FULL]: '作成処理が混み合っています。しばらくしてから再試行してください',
  [REPORT_TIMEOUT]: '時間内に作成が終わりませんでした',
  [REPORT_COMPANY_UNKNOWN]: '委託会社コードが見つかりません',
};

// 検索した時点の条件。検索欄の条件が変わったら捨てる(古い条件のまま作らないため)。一覧が
// 届く前に条件が変わった検索も、届いた時点で採らない。
const searchedQuery = ref<DropdownQuery | null>(null);
const latestQuery = useLatest();
// 生成中に条件が変わったら、その生成の結果では遷移しない。
const latestFill = useLatest();
const filling = ref(false);
const failure = ref<string | null>(null);

// 0 件で 4 段がそろっているときの、作る値入り HTML の id。作れないときは null。
const createId = computed(() => {
  const q = searchedQuery.value;
  if (!q || !searched.value || rows.value.length > 0 || newBaseDate.value !== 'allow') {
    return null;
  }
  const { companyCode, fundCode, baseDate, editionType } = q;
  if (!companyCode || !fundCode || !baseDate || !editionType) {
    return null;
  }
  return templateIdFromFileName(templateFileName({ companyCode, fundCode, baseDate, editionType }));
});

function onQueryChange() {
  latestQuery.begin();
  latestFill.begin();
  searchedQuery.value = null;
  filling.value = false;
  failure.value = null;
}

async function createAndOpen() {
  const id = createId.value;
  if (!id || filling.value) {
    return;
  }
  const isLatest = latestFill.begin();
  filling.value = true;
  failure.value = null;
  const res = await repo.fillTemplate(id);
  if (!isLatest()) {
    return;
  }
  filling.value = false;
  if (isErr(res)) {
    failure.value = FAILURE_TEXT[res.error.code ?? ''] ?? res.error.message;
    return;
  }
  router.push(editorRoute(id, { created: false }));
}

async function search(q: DropdownQuery) {
  const isLatest = latestSearch.begin();
  const isSameQuery = latestQuery.begin();
  searchedQuery.value = null;
  failure.value = null;
  const result = await run(() => repo.listTemplates(q));
  if (isErr(result) || !isLatest()) { return; }
  rows.value = result.value;
  searched.value = true;
  if (isSameQuery()) {
    searchedQuery.value = { ...q };
  }
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
    <SearchFilters
      dropdown-scope="edit"
      :new-base-date="newBaseDate"
      :unknown-date-text="UNKNOWN_DATE_TEXT"
      @search="search"
      @restore="search"
      @update="onQueryChange"
    />
    <EmptyState v-if="createId" :icon="FilePlus" title="この基準日の帳票はまだありません">
      <p v-if="filling" class="text-xs text-muted-foreground" role="status">値入り HTML を作成しています</p>
      <p v-if="failure" class="text-xs text-destructive" role="alert">{{ failure }}</p>
      <button
        type="button"
        :class="buttonVariants({ size: 'sm' })"
        :disabled="filling"
        @click="createAndOpen"
      >
        {{ failure ? '再試行' : '作成して開く' }}
      </button>
    </EmptyState>
    <TemplateTable
      v-else-if="searched"
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
