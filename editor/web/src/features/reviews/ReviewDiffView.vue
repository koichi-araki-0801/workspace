<script setup lang="ts">
// =============================================================================
// ReviewDiffView.vue — 確定保存申請の精査画面(パーツ単位の前後プレビュー + 承認/却下)
// =============================================================================
// 版比較のページ左右並列ではなく、パーツ(= `.page` 直下 top-level block)= 1 行の縦リストで
// 「変更前 | 変更後」を並べる。差分・着色は既存の block diff エンジン(`htmlBlockDiff`)を
// 流用(`reviewDiffService` が組み立て)。承認は approver|admin のみで、承認時にサーバが
// 実ファイル + git へ反映する(`reviewRepo.ts`)。
import { isErr, isOk, type ReviewRequest } from '@editor/shared';
import { Check, ClipboardCheck, Loader2, X } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewRepo } from '@/api/repositories';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { toastSuccess } from '@/components/ui/toast';
import {
  type BlockStatus,
  HL_ADDED,
  HL_CHANGED,
  HL_DEL,
  HL_INS,
  HL_REMOVED,
} from '@/features/compare/htmlBlockDiff';
import AttributeBar from '@/features/editor/AttributeBar.vue';
import { formatDateTimeShort } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useAuthStore } from '@/stores/auth';
import {
  type ReviewChangeSummary,
  type ReviewPartRow,
  useReviewDiffService,
} from './services/reviewDiffService';

const props = defineProps<{ reqId: string }>();

const diffService = useReviewDiffService();
const reviews = useReviewRepo();
const auth = useAuthStore();
const router = useRouter();
const { loading, run: runLoad } = useAsyncResult();
const { loading: deciding, run: runDecide } = useAsyncResult();

const review = ref<ReviewRequest | null>(null);
const rows = ref<ReviewPartRow[]>([]);
const summary = ref<ReviewChangeSummary>({ total: 0, changed: 0, added: 0, removed: 0 });
const cssBefore = ref('');
const cssAfter = ref('');
const loadError = ref(false);

// 既定は変更パーツのみ。トグルで「変更なし」も表示できる。
const showUnchanged = ref(false);
const visibleRows = computed(() =>
  showUnchanged.value ? rows.value : rows.value.filter((r) => r.status !== 'same'),
);

const comment = ref('');

const ORIGIN_LABEL: Record<ReviewRequest['origin'], string> = { edit: '編集', create: '新規作成' };

const STATUS_BADGE: Record<
  BlockStatus,
  { label: string; variant: 'warning' | 'success' | 'destructive' | 'secondary' }
> = {
  changed: { label: '変更', variant: 'warning' },
  added: { label: '追加', variant: 'success' },
  removed: { label: '削除', variant: 'destructive' },
  same: { label: '変更なし', variant: 'secondary' },
};

// 既に処理済み(承認/却下)か。処理済みは閲覧のみ。pending かつ approver のみ操作可。
const canDecide = computed(() => auth.isApprover && review.value?.status === 'pending');

// ── iframe ドキュメント組み立て(CompareResultView と同じ着色 CSS) ──
const HIGHLIGHT_CSS = `
  body{margin:0;padding:14px;background:#fff;}
  .${HL_CHANGED}{background:rgba(220,38,38,.06)!important;box-shadow:inset 3px 0 0 #dc2626;}
  .${HL_ADDED}{background:rgba(22,163,74,.08)!important;box-shadow:inset 3px 0 0 #16a34a;}
  .${HL_REMOVED}{background:rgba(217,119,6,.08)!important;box-shadow:inset 3px 0 0 #d97706;}
  .${HL_INS}{background:rgba(22,163,74,.18);color:#15803d;text-decoration:underline;border-radius:2px;}
  .${HL_DEL}{background:rgba(220,38,38,.14);color:#b91c1c;text-decoration:underline;border-radius:2px;}
`;
function buildDoc(fragment: string, css: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><style>${css}</style><style>${HIGHLIGHT_CSS}</style></head><body>${fragment}</body></html>`;
}

// `iframe` を中身の高さに合わせ、幅変化にも追随させる(CompareResultView と同方式)。
function fitTo(f: HTMLIFrameElement | null | undefined) {
  if (!f) return;
  try {
    const h = f.contentDocument?.body?.scrollHeight;
    if (h) f.style.height = `${h + 4}px`;
  } catch {
    /* ignore cross-doc */
  }
}
const frameObservers = new WeakMap<HTMLIFrameElement, ResizeObserver>();
const observed: HTMLIFrameElement[] = [];
function fitFrame(e: Event) {
  const f = e.target as HTMLIFrameElement;
  fitTo(f);
  if (!frameObservers.has(f)) {
    const ro = new ResizeObserver(() => fitTo(f));
    ro.observe(f);
    frameObservers.set(f, ro);
    observed.push(f);
  }
}
onBeforeUnmount(() => {
  for (const f of observed) frameObservers.get(f)?.disconnect();
  observed.length = 0;
});

async function load() {
  loadError.value = false;
  const res = await runLoad(() => diffService.buildDiff(props.reqId));
  if (isErr(res)) {
    loadError.value = true;
    return;
  }
  review.value = res.value.review;
  rows.value = res.value.rows;
  summary.value = res.value.summary;
  cssBefore.value = res.value.cssBefore;
  cssAfter.value = res.value.cssAfter;
}

async function approve() {
  const res = await runDecide(() =>
    reviews.approveReview(props.reqId, { comment: comment.value.trim() || undefined }),
  );
  if (isOk(res)) {
    toastSuccess('承認しました（本番テンプレートへ反映しました）');
    router.push({ name: 'reviews' });
  }
}

async function reject() {
  const res = await runDecide(() =>
    reviews.rejectReview(props.reqId, { comment: comment.value.trim() || undefined }),
  );
  if (isOk(res)) {
    toastSuccess('却下しました');
    router.push({ name: 'reviews' });
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <!-- ヘッダ -->
    <div class="flex flex-wrap items-center gap-3 border-b pb-3">
      <Button variant="outline" size="sm" @click="router.push({ name: 'reviews' })">
        ← 一覧へ
      </Button>
      <span class="text-lg font-bold">確定保存の精査</span>
      <template v-if="review">
        <Badge variant="secondary">{{ ORIGIN_LABEL[review.origin] }}</Badge>
        <AttributeBar :attributes="review.attributes" class="min-w-0 flex-1" />
        <span class="text-xs text-muted-foreground">
          申請: {{ review.submittedBy }}・{{ formatDateTimeShort(review.submittedAt) }}
        </span>
      </template>
    </div>

    <p v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" /> 前後プレビューを生成中…
    </p>
    <p v-else-if="loadError" class="text-sm text-destructive">
      申請の読み込みに失敗しました。時間をおいて再度お試しください。
    </p>

    <template v-else-if="review">
      <!-- 集計 + 表示トグル -->
      <div class="flex flex-wrap items-center gap-3">
        <span class="text-sm font-medium">
          変更パーツ {{ summary.changed + summary.added + summary.removed }} 件
          <span class="text-muted-foreground">
            （変更{{ summary.changed }} / 追加{{ summary.added }} / 削除{{ summary.removed }}）
          </span>
        </span>
        <label class="ml-auto flex cursor-pointer items-center gap-1.5">
          <Checkbox v-model="showUnchanged" />
          <span class="text-xs">変更なしも表示</span>
        </label>
      </div>

      <EmptyState
        v-if="visibleRows.length === 0"
        :icon="ClipboardCheck"
        title="表示できる差分がありません"
        :hint="
          showUnchanged
            ? 'このテンプレートにはパーツがありません。'
            : '現行版と差分がありません（変更なし）。'
        "
      />

      <!-- パーツ行リスト(パーツ = 1 行・変更前 | 変更後) -->
      <ul v-else class="space-y-3">
        <li v-for="row in visibleRows" :key="row.key" class="rounded-[12px] border bg-card shadow-sm">
          <div class="flex items-center gap-2 border-b px-4 py-2">
            <span class="text-sm font-bold">{{ row.label }}</span>
            <Badge :variant="STATUS_BADGE[row.status].variant">
              {{ STATUS_BADGE[row.status].label }}
            </Badge>
          </div>
          <div class="grid gap-3 p-3 md:grid-cols-2">
            <figure class="space-y-1">
              <figcaption class="text-xs text-muted-foreground">変更前(現行版)</figcaption>
              <div
                v-if="row.status === 'added'"
                class="grid place-items-center rounded border border-dashed bg-muted/30 py-8 text-xs text-muted-foreground"
              >
                （なし・新規追加）
              </div>
              <div v-else class="overflow-hidden rounded border bg-white">
                <iframe
                  :srcdoc="buildDoc(row.beforeHtml, cssBefore)"
                  title="変更前"
                  class="block w-full"
                  style="height: 120px; border: 0"
                  @load="fitFrame"
                />
              </div>
            </figure>
            <figure class="space-y-1">
              <figcaption class="text-xs text-muted-foreground">変更後(申請版)</figcaption>
              <div
                v-if="row.status === 'removed'"
                class="grid place-items-center rounded border border-dashed bg-muted/30 py-8 text-xs text-muted-foreground"
              >
                （なし・削除）
              </div>
              <div v-else class="overflow-hidden rounded border bg-white">
                <iframe
                  :srcdoc="buildDoc(row.afterHtml, cssAfter)"
                  title="変更後"
                  class="block w-full"
                  style="height: 120px; border: 0"
                  @load="fitFrame"
                />
              </div>
            </figure>
          </div>
        </li>
      </ul>

      <!-- 承認/却下(精査者のみ・pending のみ) -->
      <div v-if="canDecide" class="space-y-2 rounded-[12px] border bg-muted/30 p-4">
        <label class="text-sm font-medium" for="review-comment">理由・メモ（却下時は必須推奨）</label>
        <textarea
          id="review-comment"
          v-model="comment"
          rows="2"
          placeholder="承認メモ、または却下理由を入力します。"
          class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div class="flex items-center justify-end gap-2">
          <Button variant="outline" :disabled="deciding" @click="reject">
            <Loader2 v-if="deciding" class="h-4 w-4 animate-spin" />
            <X v-else class="h-4 w-4" /> 却下
          </Button>
          <Button :disabled="deciding" @click="approve">
            <Loader2 v-if="deciding" class="h-4 w-4 animate-spin" />
            <Check v-else class="h-4 w-4" /> 承認する
          </Button>
        </div>
      </div>

      <!-- 処理済み or 閲覧のみ -->
      <div
        v-else-if="review.status !== 'pending'"
        class="rounded-[12px] border bg-muted/30 p-4 text-sm"
      >
        この申請は
        <span class="font-medium">{{ review.status === 'approved' ? '承認済' : '却下済' }}</span>
        です（{{ review.reviewedBy }}・{{ formatDateTimeShort(review.reviewedAt) }}）。
        <span v-if="review.comment" class="block text-muted-foreground">メモ: {{ review.comment }}</span>
      </div>
      <p v-else class="text-sm text-muted-foreground">
        承認操作には精査者(承認者)権限が必要です。
      </p>
    </template>
  </div>
</template>
