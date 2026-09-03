<script setup lang="ts">
// =============================================================================
// ReviewTabView.vue — 承認タブ(編集タブで開いているテンプレート 1 件の申請を縦に並べて決着)
// =============================================================================
// 対象テンプレートは `resolveReviewTarget` が決める(`?template=` → 編集タブの直前画面)。
// 申請は状態の要約箱(承認待ち / 承認済み / 却下)で絞り、新しい順にアコーディオンで並べる。
// 展開した区画だけが `ReviewDetail`(組版 iframe 2 面)を持ち、同時展開は `reviewAccordion`
// の上限に従う。各区画の右にコメントパネルを置き、行クリックで見た目比較の該当ページへ送る。
// 決着しても画面に留まり、区画が決着済み表示へ変わる(次の申請へ続けて進める)。見出しと
// 説明文は精査者/編集者でロールが違う(旧 `ReviewQueueView` の分岐を踏襲)。
import { isErr, isOk, type ReviewRequestMeta, type ReviewStatus } from '@editor/shared';
import { ChevronDown, ChevronRight, ClipboardCheck, Info } from '@lucide/vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useNoteRepo, useReviewRepo, useTemplateRepo } from '@/api/repositories';
import AttributeBar from '@/components/AttributeBar.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import CommentPanel from '@/features/editor/comments/CommentPanel.vue';
import { partLabelMap, partPageIndexMap } from '@/features/editor/partKey';
import { useComments } from '@/features/editor/useComments';
import { formatDateTimeShort } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useLatest } from '@/lib/useLatest';
import { useAuthStore } from '@/stores/auth';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
import { useTabMemoryStore } from '@/stores/tabMemory';
import ReviewDetail from './ReviewDetail.vue';
import { resolveReviewTarget } from './resolveReviewTarget';
import { toggleExpanded } from './reviewAccordion';

const route = useRoute();
const router = useRouter();
const reviews = useReviewRepo();
const templates = useTemplateRepo();
const noteRepo = useNoteRepo();
const auth = useAuthStore();
const memory = useTabMemoryStore();
const pending = usePendingReviewsStore();
const { loading, run } = useAsyncResult();
const latestLoad = useLatest();

/** 見出し・説明文は旧 `ReviewQueueView` と同じくロールで分ける(精査者=承認する側 / 編集者=自分の申請を追う側)。 */
const heading = computed(() => (auth.isApprover ? '承認' : '申請状況'));
const description = computed(() =>
  auth.isApprover
    ? '編集タブで開いているテンプレートの申請を、1 件ずつ確認して承認・差し戻しします。'
    : '編集タブで開いているテンプレートについて、自分が出した申請の状況を確認します。',
);

// ── 1. 対象テンプレート ──
const targetId = computed(() => resolveReviewTarget(route.query, memory.pathFor('edit')));

// 選択中パーツ(コメント宛先)とアコーディオンの展開状態。
const selectedKey = ref<string | null>(null);
const expanded = ref<string[]>([]);
watch(targetId, () => {
  // 同じルートで template だけが変わると画面は再マウントされない。前テンプレートの選択
  // パーツ・展開状態を持ち越さないよう、下の読み込み系 watch より先にリセットする。
  selectedKey.value = null;
  expanded.value = [];
});

// ── 2. 申請一覧(全状態を 1 回で取り、対象テンプレートで絞る) ──
const all = ref<ReviewRequestMeta[]>([]);
const mine = computed(() => all.value.filter((m) => m.templateId === targetId.value));

const SUMMARY_FILTERS: { label: string; value: ReviewStatus }[] = [
  { label: '承認待ち', value: 'pending' },
  { label: '承認済み', value: 'approved' },
  { label: '却下', value: 'rejected' },
];
const statusFilter = ref<ReviewStatus | 'all'>('pending');
const countOf = (s: ReviewStatus) => mine.value.filter((m) => m.status === s).length;
const items = computed(() =>
  (statusFilter.value === 'all' ? mine.value : mine.value.filter((m) => m.status === statusFilter.value))
    .slice()
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
);
function toggleFilter(v: ReviewStatus) {
  statusFilter.value = statusFilter.value === v ? 'all' : v;
}

// 行バッジ・決着状態行の文言は「却下」でなく「差し戻し」で統一する(要約箱ラベルのみ
// 「却下」を残す — 短い箱ラベルとしての指定)。
const STATUS_META: Record<ReviewStatus, { label: string; variant: 'warning' | 'success' | 'destructive' }> = {
  pending: { label: '承認待ち', variant: 'warning' },
  approved: { label: '承認済み', variant: 'success' },
  rejected: { label: '差し戻し', variant: 'destructive' },
};
const ORIGIN_LABEL: Record<ReviewRequestMeta['origin'], string> = { edit: '編集', create: '新規作成' };

async function load() {
  const isLatest = latestLoad.begin();
  const res = await run(() => reviews.listReviews({}));
  if (!isErr(res) && isLatest()) all.value = res.value;
}
onMounted(load);
watch(targetId, load);

// ── 3. アコーディオン(既定は先頭 1 件を開く) ──
watch(
  items,
  (list) => {
    // フィルタ切替で見えなくなった id が同時展開の枠を食わないようにする。
    const visible = new Set(list.map((m) => m.id));
    expanded.value = expanded.value.filter((id) => visible.has(id));
    if (expanded.value.length === 0 && list.length > 0) expanded.value = [list[0].id];
  },
  { immediate: true },
);
function toggle(id: string) {
  expanded.value = toggleExpanded(expanded.value, id);
}
const detailRefs = reactive<Record<string, InstanceType<typeof ReviewDetail> | undefined>>({});

/** 決着した申請を一覧へ写す(要約箱の件数もここで動く)。承認待ちバッジも取り直す。 */
function onDecided(meta: ReviewRequestMeta) {
  all.value = all.value.map((m) => (m.id === meta.id ? meta : m));
  void pending.refresh();
}
const allDone = computed(() => targetId.value !== null && mine.value.length > 0 && countOf('pending') === 0);

// ── 4. コメント(対象テンプレートの全投稿。宛先パーツは区画内のセレクトで選ぶ) ──
const comments = useComments(() => targetId.value ?? '', () => selectedKey.value, noteRepo);
watch(targetId, () => void comments.reload(), { immediate: true });

/** パーツの表示ラベルとページ index。確定版の本文から `partKey.ts` と同じ規則で作る。 */
const partLabels = ref<Map<string, string>>(new Map());
const partPages = ref<Map<string, number>>(new Map());
async function loadParts() {
  partLabels.value = new Map();
  partPages.value = new Map();
  const id = targetId.value;
  if (!id) return;
  const tpl = await templates.getTemplate(id);
  if (!isOk(tpl)) return;
  const body = new DOMParser().parseFromString(tpl.value.filled, 'text/html').body;
  partLabels.value = partLabelMap(body);
  partPages.value = partPageIndexMap(body);
}
watch(targetId, loadParts, { immediate: true });

function focusPart(reqId: string, key: string) {
  selectedKey.value = key;
  const page = partPages.value.get(key);
  if (page !== undefined) detailRefs[reqId]?.gotoPage(page);
}

function goEdit() {
  if (targetId.value) router.push({ name: 'editor', params: { id: targetId.value } });
  else router.push({ name: 'edit' });
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-lg font-bold">{{ heading }}</h2>
      <p class="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Info class="h-3.5 w-3.5 shrink-0" />
        {{ description }}
      </p>
    </div>

    <!-- 対象が決まらない / 申請が無い -->
    <EmptyState
      v-if="!targetId"
      :icon="ClipboardCheck"
      title="編集タブでテンプレートを開いてから、承認タブを押してください"
      hint="承認タブは、編集タブで開いているテンプレートの申請を表示します。"
    >
      <Button variant="outline" @click="goEdit">編集タブへ</Button>
    </EmptyState>

    <template v-else>
      <div class="flex flex-wrap items-center gap-3 rounded-[12px] border bg-card px-4 py-3">
        <span class="text-sm font-bold">対象テンプレート</span>
        <span class="mono text-sm">{{ targetId }}</span>
        <span class="flex-1" />
        <Button variant="outline" size="sm" @click="goEdit">編集画面へ</Button>
      </div>

      <!-- 状態の要約箱 = 絞り込み(同じ箱の再クリックで解除) -->
      <div class="grid grid-cols-3 gap-3" data-review-summary>
        <button
          v-for="f in SUMMARY_FILTERS"
          :key="f.value"
          type="button"
          class="rounded-[12px] border bg-card px-4 py-3 text-left shadow-sm transition-colors"
          :class="statusFilter === f.value ? 'ring-2 ring-ring' : 'hover:bg-muted/40'"
          :data-summary="f.value"
          :aria-pressed="statusFilter === f.value"
          @click="toggleFilter(f.value)"
        >
          <div class="text-[12px] text-muted-foreground">{{ f.label }}</div>
          <div class="text-2xl font-bold">{{ countOf(f.value) }}</div>
        </button>
      </div>

      <Skeleton v-if="loading && mine.length === 0" class="h-24 w-full" />
      <EmptyState
        v-else-if="mine.length === 0"
        :icon="ClipboardCheck"
        title="このテンプレートには申請がありません"
        hint="編集画面のプレビューから「確定保存を申請」すると、ここに並びます。"
      />
      <EmptyState
        v-else-if="items.length === 0"
        :icon="ClipboardCheck"
        title="この状態の申請はありません"
        hint="上の箱をもう一度押すと絞り込みを解除します。"
      />

      <!-- アコーディオン -->
      <ul v-else class="space-y-3" data-review-list>
        <li v-for="m in items" :key="m.id" class="rounded-[12px] border bg-card shadow-sm" :data-review-item="m.id">
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left"
            data-review-toggle
            @click="toggle(m.id)"
          >
            <ChevronDown v-if="expanded.includes(m.id)" class="h-4 w-4 shrink-0" />
            <ChevronRight v-else class="h-4 w-4 shrink-0" />
            <Badge :variant="STATUS_META[m.status].variant">{{ STATUS_META[m.status].label }}</Badge>
            <Badge variant="secondary">{{ ORIGIN_LABEL[m.origin] }}</Badge>
            <AttributeBar :attributes="m.attributes" class="min-w-0 flex-1" />
            <span class="text-xs text-muted-foreground">
              申請: {{ m.submittedBy }}・{{ formatDateTimeShort(m.submittedAt) }}
            </span>
            <span v-if="m.changedSummary" class="basis-full text-xs text-muted-foreground">
              変更 {{ m.changedSummary.count }} か所<template v-if="m.changedSummary.names.length">
                （{{ m.changedSummary.names.join('、') }}）</template
              >（申請者の申告。実際の差分は開いて確認します）
            </span>
            <span v-if="m.reviewedBy" class="basis-full text-xs text-muted-foreground">
              {{ m.status === 'approved' ? '承認' : '差し戻し' }}: {{ m.reviewedBy }}・{{ formatDateTimeShort(m.reviewedAt) }}
              <template v-if="m.status === 'rejected' && m.comment">・理由: {{ m.comment }}</template>
            </span>
          </button>

          <div v-if="expanded.includes(m.id)" class="grid gap-4 border-t p-4 xl:grid-cols-[minmax(0,1fr)_312px]">
            <ReviewDetail
              :ref="(el) => { detailRefs[m.id] = el as InstanceType<typeof ReviewDetail> | undefined; }"
              :req-id="m.id"
              @decided="onDecided"
            />
            <aside class="flex max-h-[720px] min-h-[320px] flex-col overflow-hidden rounded-[12px] border bg-card">
              <div class="flex items-center gap-2 border-b px-3 py-2 text-[12.5px] font-bold">
                コメント
                <span class="flex-1" />
                <select v-model="selectedKey" class="max-w-[170px] rounded border bg-background px-1.5 py-0.5 text-[11px] font-normal" aria-label="コメントの宛先パーツ">
                  <option :value="null">宛先を選ぶ</option>
                  <option v-for="[key, label] in [...partLabels.entries()]" :key="key" :value="key">{{ label }}</option>
                </select>
              </div>
              <CommentPanel
                :entries="comments.all.value"
                :selected-key="selectedKey"
                :can-add="selectedKey !== null"
                :part-labels="partLabels"
                compact
                @add="(content, kind) => comments.add(content, { kind })"
                @reply="comments.reply"
                @set-status="comments.setStatus"
                @update="comments.update"
                @remove="comments.remove"
                @focus="(key) => focusPart(m.id, key)"
              />
            </aside>
          </div>
        </li>
      </ul>

      <div v-if="allDone" class="flex items-center gap-3 rounded-[12px] border bg-muted/30 px-4 py-3 text-sm">
        このテンプレートの承認待ちはすべて決着しました。
        <Button size="sm" @click="router.push({ name: 'edit' })">編集タブへ戻る</Button>
      </div>
    </template>
  </div>
</template>
