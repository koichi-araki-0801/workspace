<script setup lang="ts">
// =============================================================================
// ReviewDiffView.vue — 確定保存申請の精査画面(見た目比較主体 + 通知集約 + 承認/差し戻し/保留)
// =============================================================================
// 主表示は「修正前｜修正後」の左右組版比較(`ReviewVisualCompare`)。事務担当者の主観点は
// 「最終の見た目がどうなるか」であり、パーツ単位の縦リストは「文字の変更を一覧で見る」タブへ
// 退避する(既存の block diff エンジン `htmlBlockDiff` をそのまま流用、`reviewDiffService` が
// 組み立て)。技術語彙の警告 4 種は `ReviewNoticeBar` の 1 行へ集約する。承認は approver|admin
// のみで、承認時にサーバが実ファイル + git へ反映する(`reviewRepo.ts`)。
import { type ApproveReviewResult, isOk, type ReviewRequest } from '@editor/shared';
import { Check, ClipboardCheck, Loader2, X } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
import { useTemplatePreviewService } from '@/features/preview/services/templatePreviewService';
import { formatDateTimeShort } from '@/lib/format';
import { useIframeAutoFit } from '@/lib/useIframeAutoFit';
import { useAuthStore } from '@/stores/auth';
import ReviewNoticeBar from './ReviewNoticeBar.vue';
import ReviewVisualCompare from './ReviewVisualCompare.vue';
import type { ReviewPartRow } from './services/reviewDiffService';
import { useReviewDiff } from './useReviewDiff';

const props = defineProps<{ reqId: string }>();

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const preview = useTemplatePreviewService();
// データ取得と承認/却下/保留アクションは composable に委譲(遷移/トーストのみ View に残す)。
const {
  review,
  rows,
  summary,
  cssBefore,
  cssAfter,
  beforeBodyHtml,
  afterBodyHtml,
  changedPageIndexes,
  beforePageCount,
  afterPageCount,
  truncated,
  cssChanged,
  printOnlyCss,
  loadError,
  loading,
  deciding,
  load,
  approve: approveReview,
  reject: rejectReview,
  hold,
} = useReviewDiff(() => props.reqId);

// 表示タブ。既定は見た目比較(事務担当者の主観点は「最終の見た目がどうなるか」)。
const activeTab = ref<'visual' | 'text'>('visual');

// 既定は変更パーツのみ。トグルで「変更なし」も表示できる。
const showUnchanged = ref(false);
const visibleRows = computed(() =>
  showUnchanged.value ? rows.value : rows.value.filter((r) => r.status !== 'same'),
);

/** 変更要約 1 行(実差分由来。changedSummary 自己申告とは独立)。 */
const changedNames = computed(() => {
  const names = [...new Set(rows.value.filter((r) => r.status !== 'same').map((r) => r.label))];
  return names.slice(0, 5);
});

/**
 * 一度に描画するパーツ行数の上限。各行は申請者制御の CSS(最大 1 MiB)を丸ごとインライン
 * した iframe を 2 つ作るため、上限が無いと 1 件の申請(数千の小 top-level block を全て
 * 変更にした形)で承認者のブラウザを固められる。上限超過は描画せず、その旨を画面へ出す
 * (承認者は分割再申請を求められる)。
 */
const MAX_RENDERED_ROWS = 200;
const cappedRows = computed(() => visibleRows.value.slice(0, MAX_RENDERED_ROWS));
const hiddenRowCount = computed(() => Math.max(0, visibleRows.value.length - MAX_RENDERED_ROWS));

/**
 * 各行の `srcdoc` を**データ依存の computed で 1 度だけ**組み立てる。`buildDoc` は
 * `buildDiffDoc` がカスケードレイヤ名を毎回乱数生成する非冪等関数なので、テンプレートで
 * 直接呼ぶと(メモ欄への 1 文字入力など)無関係な再描画のたびに全 `srcdoc` 文字列が変わり、
 * Vue が全 iframe を作り直す。ここで一度だけ組み立てて安定参照にすると、行データか CSS が
 * 変わったときにしか iframe が再構築されない。
 */
interface RenderedRow {
  row: ReviewPartRow;
  beforeDoc: string;
  afterDoc: string;
}
const renderedRows = computed<RenderedRow[]>(() =>
  cappedRows.value.map((row) => ({
    row,
    beforeDoc: row.status === 'added' ? '' : buildDoc(row.beforeHtml, cssBefore.value),
    afterDoc: row.status === 'removed' ? '' : buildDoc(row.afterHtml, cssAfter.value),
  })),
);

const comment = ref('');
// 空理由で「差し戻す」を押した場合のインラインエラー。入力が始まったら消す。
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

/**
 * 「処理済み(閲覧のみ)」表示の状態ラベル。pending は別分岐(`canDecide`)、held は
 * 保留情報(`heldBy`/`heldAt`/`holdComment`)専用の分岐を持つため、ここには来ない。
 */
const DECIDED_STATUS_LABEL: Record<'approved' | 'rejected', string> = {
  approved: '承認済み',
  rejected: '差し戻し済',
};

// pending/held は精査者が操作できる。処理済み(承認/差し戻し)は閲覧のみ。
const canDecide = computed(
  () =>
    auth.isApprover &&
    (review.value?.status === 'pending' || review.value?.status === 'held'),
);

// 編集画面の「承認待ち」バッジ経由で来たか。`fromEdit` はフラグとしてのみ使い、戻り先の
// テンプレ id は query を信用せず申請自身の `templateId` を使う(細工 URL で任意 id へ
// 飛ばされない)。編集セッションは離脱ガードのホワイトリスト(`useTemplateEditor`)が維持済み。
const cameFromEdit = computed(
  () => typeof route.query.fromEdit === 'string' && route.query.fromEdit.length > 0,
);

/** ヘッダの戻るボタン。編集画面から来たときだけ編集へ戻す(それ以外はキュー一覧へ)。 */
function goBack() {
  const tplId = review.value?.templateId;
  if (cameFromEdit.value && tplId) router.push({ name: 'editor', params: { id: tplId } });
  else router.push({ name: 'reviews' });
}

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
 * 変更箇所の色分けを面積上限(`MAX_LCS_CELLS`)で諦め、全文まとめての色分けに落ちたパーツか。
 * `ReviewPartRow` は presentation 用の写しでフラグ列を持たないため、着色済みマークアップから
 * 判定する。
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
  // 差し戻しは申請者への差し戻し — 理由が残らないと編集者が直しようがないため必須にする。
  if (!comment.value.trim()) {
    rejectError.value = true;
    commentEl.value?.focus();
    return;
  }
  const res = await rejectReview(comment.value.trim());
  if (isOk(res)) {
    toastSuccess('差し戻しました');
    router.push({ name: 'reviews' });
  }
}

/** 保留(実ファイル非更新)。判断を後回しにして一覧へ戻る。 */
async function holdRequest() {
  const res = await hold(comment.value.trim() || undefined);
  if (isOk(res)) {
    toastSuccess('保留しました（一覧の「保留中」から確認を再開できます）');
    router.push({ name: 'reviews' });
  }
}

// 通知バーの「PDF を開いて確認」の生成中フラグ。ボタンを disabled にして多重クリックを防ぐ
// (`PreviewView` の `exporting` と同じパターン)。
const pdfGenerating = ref(false);

/**
 * 通知バーの「PDF を開いて確認」— 修正後 1 文書を既存の PDF 出力経路(`PreviewView` の
 * `exportPdf` と同じ `templatePreviewService.renderPdf`)で開く。対象は申請の記入済み
 * インスタンス(`review.filledHtml`)、無ければ diff 由来の申請版本文(`afterBodyHtml` +
 * `cssAfter`)。いずれも Jinja は既に解決済みのため `sample` は空でよい。新しい PDF
 * 生成経路・独自 fetch はここでは作らない。
 *
 * ダウンロードは `PreviewView.exportPdf` と同じアンカー download 方式を使う
 * (`window.open` は PDF 生成待ちの非同期処理を挟んだ後の呼び出しになり、ユーザ操作からの
 * transient activation が失効してポップアップブロックされうる)。生成した Blob URL は
 * クリック後に revoke してリークさせない。
 */
async function openPdf() {
  if (!review.value) return;
  pdfGenerating.value = true;
  try {
    const html = review.value.filledHtml ?? afterBodyHtml.value;
    const res = await preview.renderPdf(html, cssAfter.value, {}, false);
    if (!isOk(res)) {
      toast('PDFの作成に失敗しました。時間をおいて再度お試しください。', 'error');
      return;
    }
    const url = URL.createObjectURL(res.value);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${review.value.templateId}.pdf`;
    // DOM に載せてから click する(未接続 anchor の click を無視するブラウザ対策)。
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toastSuccess('PDFのダウンロードを開始しました');
  } finally {
    pdfGenerating.value = false;
  }
}

onMounted(async () => {
  await load();
  // 保留中申請の再表示時、コメント欄を空のまま「保留する」を押すと server が
  // `holdComment: null` で既存メモを上書きしてしまう。承認者が既存メモを見た上で
  // 編集/保持できるよう、held かつメモがあればコメント欄へプリフィルする。
  if (review.value?.status === 'held' && review.value.holdComment) {
    comment.value = review.value.holdComment;
  }
});
</script>

<template>
  <div class="space-y-4">
    <!-- ヘッダ -->
    <div class="flex flex-wrap items-center gap-3 border-b pb-3">
      <Button variant="outline" size="sm" @click="goBack">
        {{ cameFromEdit ? '← 編集に戻る' : '← 一覧へ' }}
      </Button>
      <span class="text-lg font-bold">申請内容の確認</span>
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
      <!-- 変更要約 1 行(実差分由来)。 -->
      <p class="text-sm">
        変更されたのは
        <strong>{{ summary.changed + summary.added + summary.removed }} か所</strong>
        <template v-if="changedNames.length">
          : <span class="font-medium text-accent-foreground">{{ changedNames.join('、') }}</span>
        </template>
      </p>

      <!-- 技術的警告 4 種(truncated / printOnlyCss / cssChanged / 行打ち切り)は 1 行へ集約。 -->
      <ReviewNoticeBar
        :css-changed="cssChanged"
        :css-before="cssBefore"
        :css-after="cssAfter"
        :print-only-css="printOnlyCss"
        :truncated="truncated"
        :hidden-row-count="hiddenRowCount"
        :pdf-generating="pdfGenerating"
        @open-pdf="openPdf"
      />

      <!-- タブ切替: 見た目比較(既定) / 文字の変更を一覧で見る -->
      <div class="flex items-center gap-1.5">
        <Button
          :variant="activeTab === 'visual' ? 'default' : 'outline'"
          size="sm"
          @click="activeTab = 'visual'"
        >
          見た目で比較
        </Button>
        <Button
          :variant="activeTab === 'text' ? 'default' : 'outline'"
          size="sm"
          @click="activeTab = 'text'"
        >
          文字の変更を一覧で見る
        </Button>
      </div>

      <ReviewVisualCompare
        v-if="activeTab === 'visual'"
        :before-html="beforeBodyHtml"
        :after-html="afterBodyHtml"
        :css-before="cssBefore"
        :css-after="cssAfter"
        :changed-page-indexes="changedPageIndexes"
        :before-page-count="beforePageCount"
        :after-page-count="afterPageCount"
        :is-create="review.origin === 'create'"
      />

      <template v-else>
        <!-- 表示トグル -->
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

        <!-- 「変更なし」の空状態は CSS も同一のときだけ出す(CSS が変わっていれば通知バーが
             一級の変更として伝えるので、HTML パーツ差分が 0 でも「差分なし」とは言わない)。 -->
        <EmptyState
          v-if="visibleRows.length === 0 && !cssChanged"
          :icon="ClipboardCheck"
          title="表示できる差分がありません"
          :hint="
            showUnchanged
              ? 'このテンプレートにはパーツがありません。'
              : '現行版と差分がありません（変更なし）。'
          "
        />

        <!-- パーツ行リスト(パーツ = 1 行・変更前 | 変更後)。行は `renderedRows`(cap 済み・
             srcdoc は 1 度だけ組み立て済み)を回す。 -->
        <ul v-else-if="renderedRows.length" class="space-y-3">
          <li
            v-for="r in renderedRows"
            :key="r.row.key"
            class="rounded-[12px] border bg-card shadow-sm"
          >
            <div class="flex items-center gap-2 border-b px-4 py-2">
              <span class="text-sm font-bold">{{ r.row.label }}</span>
              <Badge :variant="STATUS_BADGE[r.row.status].variant">
                {{ STATUS_BADGE[r.row.status].label }}
              </Badge>
              <!-- 差分自体は必ず出す。着色を諦めた旨だけ控えめに添える。 -->
              <span
                v-if="isCoarseRow(r.row)"
                class="text-xs text-muted-foreground"
                title="この箇所は変更が大きいため、変わった文字ごとの色分けはせず全文を並べています。"
              >
                この箇所は変更が大きいため、変わった文字の色付けはせず全文を並べています
              </span>
            </div>

            <!-- 本文テキストの語句差分。**親アプリの DOM に、エスケープして描く** — 下の
                 着色プレビューは申請者 CSS を載せた iframe なので、申請者は自分の要素へ
                 display/opacity/transform/font-size/@media 等を当てて変更を隠せる。ここは
                 textContent 由来で CSS の影響を受けないため、隠された変更もそのまま現れる。
                 これが承認判断の正典で、iframe プレビューは見た目確認の補助。 -->
            <div v-if="r.row.textOps.length" class="border-b px-4 py-2">
              <div class="mb-1 text-xs font-medium text-muted-foreground">
                本文の変更（申請者のスタイルに影響されない照合。確定・保存される差分）
              </div>
              <p class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                <template v-for="(op, i) in r.row.textOps" :key="i">
                  <del
                    v-if="op.type === 'del'"
                    class="rounded-sm bg-red-100 text-red-800 line-through"
                    >{{ op.text }}</del
                  >
                  <ins
                    v-else-if="op.type === 'ins'"
                    class="rounded-sm bg-green-100 text-green-800 no-underline"
                    >{{ op.text }}</ins
                  >
                  <span v-else>{{ op.text }}</span>
                </template>
              </p>
            </div>
            <div class="grid gap-3 p-3 md:grid-cols-2">
              <figure class="space-y-1">
                <figcaption class="text-xs text-muted-foreground">変更前(現行版)</figcaption>
                <div
                  v-if="r.row.status === 'added'"
                  class="grid place-items-center rounded border border-dashed bg-muted/30 py-8 text-xs text-muted-foreground"
                >
                  （なし・新規追加）
                </div>
                <div v-else class="overflow-hidden rounded border bg-white">
                  <!-- sandbox は必須。srcdoc の中身は申請者が書いた HTML/CSS である。
                       テンプレの JS は正当なコンテンツで、承認者は「JS が効いた実行結果」を
                       見て承認するので**動かす**(止めると承認していない見た目が確定する)。
                       よって `allow-scripts` は許すが、同一オリジン相当の権限は**付けない** —
                       両方を同時に付けると子は親オリジンの DOM へ到達でき sandbox が無効化
                       される。高さは子からの postMessage で受ける(`useIframeAutoFit`)。 -->
                  <iframe
                    :srcdoc="r.beforeDoc"
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
                  v-if="r.row.status === 'removed'"
                  class="grid place-items-center rounded border border-dashed bg-muted/30 py-8 text-xs text-muted-foreground"
                >
                  （なし・削除）
                </div>
                <div v-else class="overflow-hidden rounded border bg-white">
                  <!-- sandbox の意図は「変更前」ペインと同じ(上のコメントを見よ)。 -->
                  <iframe
                    :srcdoc="r.afterDoc"
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
      </template>

      <!-- 承認/差し戻し/保留(精査者のみ・pending/held のみ) -->
      <div v-if="canDecide" class="space-y-2 rounded-[12px] border bg-muted/30 p-4">
        <label class="text-sm font-medium" for="review-comment">
          コメント（差し戻し時は必須。保留時はメモとして残ります）
        </label>
        <textarea
          id="review-comment"
          ref="commentEl"
          v-model="comment"
          rows="2"
          placeholder="承認メモ、または差し戻し理由を入力します。"
          :aria-invalid="rejectError || undefined"
          class="w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="rejectError ? 'border-destructive' : 'border-input'"
        />
        <p v-if="rejectError" role="alert" class="text-xs text-destructive">
          差し戻しには理由の入力が必要です。
        </p>
        <div class="flex items-center justify-end gap-2">
          <Button variant="outline" :disabled="deciding" @click="holdRequest">保留する</Button>
          <Button variant="outline" :disabled="deciding" @click="reject">
            <Loader2 v-if="deciding" class="h-4 w-4 animate-spin" />
            <X v-else class="h-4 w-4" /> 差し戻す
          </Button>
          <Button :disabled="deciding" @click="approve">
            <Loader2 v-if="deciding" class="h-4 w-4 animate-spin" />
            <Check v-else class="h-4 w-4" /> 承認する
          </Button>
        </div>
      </div>

      <!-- 保留中(非承認者の閲覧、または「保留中」を再表示できる状態にない場合)。
           held は reviewedBy/reviewedAt を持たない(保留は独自フィールド heldBy/heldAt を使う)
           ため、下の「処理済み」分岐と共有すると「保留中 です（null・null）」の壊れた
           表示になる(レガシー申請の meta.json には無く undefined もありうるため truthy
           ガードで各フィールドを出す)。 -->
      <div v-else-if="review.status === 'held'" class="rounded-[12px] border bg-muted/30 p-4 text-sm">
        この申請は <span class="font-medium">保留中</span> です<template v-if="review.heldBy"
          >（{{ review.heldBy }}<template v-if="review.heldAt"
            >・{{ formatDateTimeShort(review.heldAt) }}</template
          >）</template
        >。
        <span v-if="review.holdComment" class="block text-muted-foreground">
          保留メモ: {{ review.holdComment }}
        </span>
      </div>
      <!-- 処理済み(承認/差し戻し)or 閲覧のみ -->
      <div
        v-else-if="review.status !== 'pending'"
        class="rounded-[12px] border bg-muted/30 p-4 text-sm"
      >
        この申請は
        <span class="font-medium">
          {{ DECIDED_STATUS_LABEL[review.status as 'approved' | 'rejected'] }}
        </span>
        です（{{ review.reviewedBy }}・{{ formatDateTimeShort(review.reviewedAt) }}）。
        <span v-if="review.comment" class="block text-muted-foreground">メモ: {{ review.comment }}</span>
      </div>
      <p v-else class="text-sm text-muted-foreground">
        承認操作には精査者(承認者)権限が必要です。
      </p>
    </template>
  </div>
</template>
