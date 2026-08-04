<script setup lang="ts">
// =============================================================================
// ReviewDiffView.vue — 確定保存申請の精査画面(パーツ単位の前後プレビュー + 承認/却下)
// =============================================================================
// 版比較のページ左右並列ではなく、パーツ(= `.page` 直下 top-level block)= 1 行の縦リストで
// 「変更前 | 変更後」を並べる。差分・着色は既存の block diff エンジン(`htmlBlockDiff`)を
// 流用(`reviewDiffService` が組み立て)。承認は approver|admin のみで、承認時にサーバが
// 実ファイル + git へ反映する(`reviewRepo.ts`)。
import { type ApproveReviewResult, isOk, type ReviewRequest } from '@editor/shared';
import { Check, ClipboardCheck, Loader2, X } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AttributeBar from '@/components/AttributeBar.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { toast, toastSuccess } from '@/components/ui/toast';
import {
  type BlockStatus,
  buildDiffDoc,
  diffHighlightCss,
  hasCoarseDiff,
} from '@/features/compare/htmlBlockDiff';
import { formatDateTimeShort } from '@/lib/format';
import { useIframeAutoFit } from '@/lib/useIframeAutoFit';
import { useAuthStore } from '@/stores/auth';
import type { ReviewPartRow } from './services/reviewDiffService';
import { useReviewDiff } from './useReviewDiff';

const props = defineProps<{ reqId: string }>();

const auth = useAuthStore();
const router = useRouter();
// データ取得と承認/却下アクションは composable に委譲(遷移/トーストのみ View に残す)。
const {
  review,
  rows,
  summary,
  cssBefore,
  cssAfter,
  loadError,
  loading,
  deciding,
  load,
  approve: approveReview,
  reject: rejectReview,
} = useReviewDiff(() => props.reqId);

// 既定は変更パーツのみ。トグルで「変更なし」も表示できる。
const showUnchanged = ref(false);
const visibleRows = computed(() =>
  showUnchanged.value ? rows.value : rows.value.filter((r) => r.status !== 'same'),
);

const comment = ref('');
// 空理由で「却下」を押した場合のインラインエラー。入力が始まったら消す。
const rejectError = ref(false);
const commentEl = ref<HTMLTextAreaElement | null>(null);
watch(comment, (v) => {
  if (v.trim()) rejectError.value = false;
});

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

// ── iframe ドキュメント組み立て(CompareResultView と共有・着色 CSS は同一、padding のみ差) ──
const HIGHLIGHT_CSS = diffHighlightCss(14);

// `iframe` を中身の高さに合わせる(CompareResultView と共有)。高さは子からの postMessage
// で受け取る — `sandbox="allow-scripts"`(same-origin なし)では親から `contentDocument` を
// 読めないためで、読めないことがテンプレ JS を隔離したまま動かすための条件である。
const { fitFrame, withHeightReporter } = useIframeAutoFit();

function buildDoc(fragment: string, css: string): string {
  return withHeightReporter(buildDiffDoc(fragment, css, HIGHLIGHT_CSS));
}

/**
 * 語句単位の着色を面積上限(`MAX_LCS_CELLS`)で諦めたパーツか。`ReviewPartRow` は
 * presentation 用の写しでフラグ列を持たないため、着色済みマークアップから判定する。
 */
function isCoarseRow(row: ReviewPartRow): boolean {
  return hasCoarseDiff(row.beforeHtml, row.afterHtml);
}

async function approve() {
  const res = await approveReview(comment.value.trim() || undefined);
  if (isOk(res)) {
    // 申請後に現行版が変更されていた場合は上書き注意を促す(承認自体はブロックしない)。
    if (res.value.staleWarning) {
      toast(
        '承認して反映しました。ただし申請後に現行版が変更されていたため、上書きした可能性があります。',
        'default',
        6000,
      );
    } else {
      toastSuccess('承認しました（本番テンプレートへ反映しました）');
    }
    notifySyncResult(res.value.sync);
    notifyNoteMasterResult(res.value.noteMaster);
    router.push({ name: 'reviews' });
  }
}

/**
 * 承認直後に走った交付版⇄全体版のパーツ自動同期の結果を通知する。同期はベストエフォート
 * (失敗しても承認は成立)のため、失敗・スキップは destructive/長め表示で見落としを防ぐ。
 * スキップの内訳(競合など)は同期先テンプレを開いた時のバナーが恒常表示する。
 */
function notifySyncResult(sync: ApproveReviewResult['sync']): void {
  if (!sync) return;
  if (sync.error) {
    toast(`ペア(${sync.pairTemplateId})への自動同期に失敗しました: ${sync.error}`, 'error', 8000);
    return;
  }
  if (sync.applied.length === 0 && sync.skipped.length === 0) return;
  const skippedNote = sync.skipped.length > 0 ? `・スキップ ${sync.skipped.length} 件(要確認)` : '';
  toast(
    `ペア ${sync.pairTemplateId} へ ${sync.applied.length} パーツを自動同期しました${skippedNote}`,
    'default',
    6000,
  );
}

/**
 * 承認直後に走った注記マスタ書き戻し(`次回反映既定`=`反映` パーツ)の結果を通知する。
 * ペア同期と同じベストエフォートのため失敗は destructive/長め表示、成功は書き戻しが
 * あったときだけ短く伝える(対象パーツ無しの承認で毎回鳴らさない)。
 */
function notifyNoteMasterResult(noteMaster: ApproveReviewResult['noteMaster']): void {
  if (!noteMaster) return;
  if (noteMaster.error) {
    toast(`注記マスタへの反映に失敗しました: ${noteMaster.error}`, 'error', 8000);
    return;
  }
  if (noteMaster.updated.length === 0) return;
  toast(
    `注記マスタへ ${noteMaster.updated.length} パーツを反映しました（次回作成のテンプレートに適用されます）`,
    'default',
    6000,
  );
}

async function reject() {
  // 却下は申請者への差し戻し — 理由が残らないと編集者が直しようがないため必須にする。
  if (!comment.value.trim()) {
    rejectError.value = true;
    commentEl.value?.focus();
    return;
  }
  const res = await rejectReview(comment.value.trim());
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
            <!-- 差分自体は必ず出す。語句単位の着色だけ諦めた旨を控えめに添える。 -->
            <span
              v-if="isCoarseRow(row)"
              class="text-xs text-muted-foreground"
              title="テキストが大きいため語句単位の着色を省略し、変更前後の全文を色分けしています。"
            >
              この箇所は差分が大きいため簡易表示です
            </span>
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
                <!-- sandbox は必須。srcdoc の中身は申請者が書いた HTML/CSS である。
                     テンプレの JS は正当なコンテンツで、承認者は「JS が効いた実行結果」を
                     見て承認するので**動かす**(止めると承認していない見た目が確定する)。
                     よって `allow-scripts` を許し、`allow-same-origin` は**付けない** —
                     両方を同時に付けると子は親オリジンの DOM へ到達でき sandbox が無効化
                     される。高さは子からの postMessage で受ける(`useIframeAutoFit`)。 -->
                <iframe
                  :srcdoc="buildDoc(row.beforeHtml, cssBefore)"
                  sandbox="allow-scripts"
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
                <!-- sandbox の意図は「変更前」ペインと同じ(上のコメントを見よ)。 -->
                <iframe
                  :srcdoc="buildDoc(row.afterHtml, cssAfter)"
                  sandbox="allow-scripts"
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
        <label class="text-sm font-medium" for="review-comment">理由・メモ（却下時は必須）</label>
        <textarea
          id="review-comment"
          ref="commentEl"
          v-model="comment"
          rows="2"
          placeholder="承認メモ、または却下理由を入力します。"
          :aria-invalid="rejectError || undefined"
          class="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="rejectError ? 'border-destructive' : 'border-input'"
        />
        <p v-if="rejectError" role="alert" class="text-xs text-destructive">
          却下には理由の入力が必要です。
        </p>
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
