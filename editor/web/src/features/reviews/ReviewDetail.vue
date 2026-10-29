<script setup lang="ts">
// =============================================================================
// ReviewDetail.vue — 承認タブの申請カード(左右の紙面・右欄・判定バー・申請ごと却下)
// =============================================================================
// 申請 1 件を 1 枚のカードに組む(外枠は承認タブのアコーディオンの区画が持つので、ここでは枠を
// 描かない)。上から、申請ごと却下の理由欄(開いたときだけ)、道具の行
// (ページ送り・通知バー・紙面のチェック)、作業域(左 = 左右の紙面 `ReviewVisualCompare`、
// 右 = 420px の欄でタブ「変更と判定｜コメント」)、下端の判定バー(`ReviewDecisionBar`)。
// 作業域は高さを決めた枠で、紙面と右欄はそれぞれ内側でスクロールし、判定バーは常に見える。
//
// 判定の状態と保存は `useReviewDecisions`、申請の取得と最終確定・申請ごと却下は `useReviewDiff`
// が持つ。選択は紙面・右欄の行・次の未判定のどれから来ても 1 つの番号(`selectedNo`)に集め、
// 紙面(`gotoPart`)と右欄(`revealNo`)の両方を動かす。コメントは `ReviewTabView.vue` が
// `#comments` の slot へ差し込み、宛先の番号と名前は slot の props で渡す。
// 承認タブ(`ReviewTabView.vue`)のアコーディオン 1 区画として置かれるので、ヘッダと画面遷移は
// 持たず、決着は `decided` で、選択は `select` で親へ知らせる。
import {
  type ApproveReviewResult,
  isOk,
  REVIEW_ALREADY_DECIDED,
  type ReviewRequest,
  type ReviewRequestMeta,
  reviewFinalizationIssues,
  toReviewMeta,
} from '@editor/shared';
import { Loader2 } from '@lucide/vue';
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import Button from '@/components/ui/Button.vue';
import { confirm } from '@/components/ui/confirm';
import { toast, toastSuccess } from '@/components/ui/toast';
import { useTemplatePreviewService } from '@/features/preview/services/templatePreviewService';
import { formatDateTimeShort } from '@/lib/format';
import { companyCodeOfTemplateId } from '@/lib/fundImages';
import { pairSyncResultText } from '@/lib/pairSyncText';
import { useAuthStore } from '@/stores/auth';
import ReviewDecisionBar from './ReviewDecisionBar.vue';
import ReviewDecisionList from './ReviewDecisionList.vue';
import ReviewNoticeBar from './ReviewNoticeBar.vue';
import ReviewVisualCompare from './ReviewVisualCompare.vue';
import { nextPendingNo } from './reviewDecisionState';
import type { ReviewChangeRow } from './services/reviewDiffService';
import { useReviewDecisions } from './useReviewDecisions';
import { useReviewDiff } from './useReviewDiff';

const props = defineProps<{ reqId: string }>();
const emit = defineEmits<{
  decided: [meta: ReviewRequestMeta];
  /** 選択が外れたときは `(null, null)`。 */
  select: [commentKey: string | null, no: number | null];
}>();

/** `#comments` に渡す値。番号と名前のキーはコメントの宛先のキー(`commentKeyOf`)。 */
interface CommentSlotProps {
  selectedNo: number | null;
  selectedKey: string | null;
  partNumbers: Map<string, number>;
  partNames: Map<string, string>;
}
defineSlots<{ comments?: (props: CommentSlotProps) => unknown }>();

const auth = useAuthStore();
const preview = useTemplatePreviewService();
const {
  review,
  changes,
  diff,
  cssBefore,
  cssAfter,
  afterBodyHtml,
  truncated,
  cssChanged,
  printOnlyCss,
  loadError,
  loading,
  deciding,
  load,
  approve: approveReview,
  reject: rejectReview,
  updatePartDecisions,
} = useReviewDiff(() => props.reqId);

const decisions = useReviewDecisions({
  review,
  diff,
  changes,
  save: updatePartDecisions,
  reload: load,
});
const { counts, saving } = decisions;

const DECIDED_STATUS_LABEL: Record<'approved' | 'rejected', string> = {
  approved: '承認済み',
  rejected: '却下済み',
};

// pending は精査者が操作できる。処理済み(承認/却下)は閲覧のみ。
const canDecide = computed(() => auth.isApprover && review.value?.status === 'pending');
/**
 * 判定の保存中、最終確定・申請ごと却下の処理中、読み直しの最中。どの間も操作を受け付けない
 * (読み直しの最中に押すと、古い画面のまま送ることになる)。
 */
const busy = computed(() => saving.value || deciding.value || loading.value);
const isCreate = computed(() => review.value?.origin === 'create');

// ── 1. 選択 ──

const selectedNo = ref<number | null>(null);
const visualRef = ref<InstanceType<typeof ReviewVisualCompare>>();
const listRef = ref<InstanceType<typeof ReviewDecisionList>>();

/**
 * コメントの宛先のキー。編集経路は確定版側のキー(`beforePartKey`)、作成経路は申請版のキー
 * (`partKey`)。追加パーツはどちらの経路でも null(確定版にまだ無いので書けない)。作成経路で
 * 申請版のキーをそのまま使うと、既存パーツの前に同じタグのパーツを足した申請では追加パーツの
 * キー(`p#2` など)が確定版の別のパーツのキーと重なり、そちらへコメントが付いてしまう。
 */
function commentKeyOf(c: ReviewChangeRow): string | null {
  if (c.kind === 'added') return null;
  return isCreate.value ? c.partKey : c.beforePartKey;
}

/**
 * 番号 `no` のパーツを選ぶ。`toggle` は紙面・右欄の行の押下から来たときで、選択中の番号を
 * もう一度押すと選択を外す(次の未判定・コメント一覧からの選択は外さない。次の未判定は
 * 未判定が 1 件だけなら同じ番号を返すため)。
 */
function select(no: number, toggle = false): void {
  if (toggle && no === selectedNo.value) {
    clearSelection();
    return;
  }
  const c = changes.value.find((x) => x.no === no);
  if (!c) return;
  selectedNo.value = no;
  visualRef.value?.gotoPart(no);
  void listRef.value?.revealNo(no);
  emit('select', commentKeyOf(c), no);
}

/** 選択を外して親へ知らせる(コメントの宛先も外れる)。 */
function clearSelection(): void {
  selectedNo.value = null;
  emit('select', null, null);
}

/** 紙面・右欄の行の押下。 */
function onPick(no: number): void {
  select(no, true);
}

/** コメント一覧などから宛先のキーでパーツを選ぶ。変更の無いキーは何もしない。 */
function selectPart(commentKey: string): void {
  const c = changes.value.find((x) => commentKeyOf(x) === commentKey);
  if (c) select(c.no);
}

const nextNo = computed(() =>
  nextPendingNo(changes.value, decisions.decisions.value, selectedNo.value),
);

function selectNextPending(): void {
  if (nextNo.value !== null) select(nextNo.value);
}

const selectedKey = computed(() => {
  const c = changes.value.find((x) => x.no === selectedNo.value);
  return c ? commentKeyOf(c) : null;
});

const commentSlotProps = computed<CommentSlotProps>(() => {
  const partNumbers = new Map<string, number>();
  const partNames = new Map<string, string>();
  for (const c of changes.value) {
    const key = commentKeyOf(c);
    if (key === null) continue;
    partNumbers.set(key, c.no);
    partNames.set(key, c.name);
  }
  return { selectedNo: selectedNo.value, selectedKey: selectedKey.value, partNumbers, partNames };
});

/**
 * 変更の組の識別。読み直しで同じ組が届いたときは右欄を作り直さず(選択・書きかけを保つ)、
 * 組が変わったときだけ `:key` で作り直す(表示窓と選択を新しい組に合わせ直すため)。
 */
const changesKey = computed(() => changes.value.map((c) => `${c.no}:${c.partKey}`).join('\n'));

// 変更の組が変わったら、無くなった番号の選択を外す。同じ番号が残っても宛先のキーは変わりうる
// ので、残った選択は今のキーで知らせ直す(親は `select` と slot の `selectedKey` で宛先を決める)。
watch(changesKey, () => {
  const no = selectedNo.value;
  if (no === null) return;
  const c = changes.value.find((x) => x.no === no);
  if (!c) clearSelection();
  else emit('select', commentKeyOf(c), no);
});

// ── 2. 右欄のタブ ──

const sideTab = ref<'decisions' | 'comments'>('decisions');
const SIDE_TABS = [
  { id: 'decisions', label: '変更と判定' },
  { id: 'comments', label: 'コメント' },
] as const;

/**
 * 道具の行の先頭の要素。`ReviewVisualCompare` のページ送りと紙面のチェックがここへ移る。要素が
 * できる(この区画の描画が終わる)までは、紙面の上にその場で描かれる。
 */
const toolsEl = ref<HTMLElement | null>(null);

// ── 3. ページ送り(コメント一覧の「行から該当ページへ」) ──

/**
 * 区画を開いた直後に `gotoPage` が呼ばれたときの待機 index。読み込み中は `ReviewVisualCompare` を
 * まだマウントしていないので、ここへ積んで下の `watch(visualRef, …)` に委ね、マウント後に 1 回だけ
 * 送って `null` に戻す。組版そのものの準備待ちは `ReviewVisualCompare` 側が担う。
 */
const pendingIndex = ref<number | null>(null);

function gotoPage(index: number): void {
  if (!visualRef.value) {
    pendingIndex.value = index;
    return;
  }
  visualRef.value.gotoPage(index);
}
watch(
  visualRef,
  (v) => {
    if (!v || pendingIndex.value === null) return;
    const index = pendingIndex.value;
    pendingIndex.value = null;
    v.gotoPage(index);
  },
  { flush: 'post' },
);
// 読み込みの失敗では待機 index を捨てる。残ると後の再読込で頼んでいないページ送りが 1 回起きる。
watch(loadError, (e) => {
  if (e) pendingIndex.value = null;
});

// ── 4. 最終確定 ──

/**
 * 最終確定を止める理由(未判定は判定バーが件数で出すので含めない)。文言はサーバの 400/409 と同じ
 * (shared の `reviewFinalizationIssues`)。古い edit 申請は判定を当てる差分をサーバが作れないので、
 * 判定があると確定できない。
 */
const blockedReasons = computed(() => {
  const r = review.value;
  return reviewFinalizationIssues({
    pendingPartKeys: [],
    unknownDecisionPartKeys: decisions.unknownDecisionPartKeys.value,
    duplicateDecisionPartKeys: decisions.duplicateDecisionPartKeys.value,
    truncated: truncated.value,
    legacyDecisions:
      r?.origin === 'edit' &&
      (r.baseHtml === undefined || r.baseCss === undefined) &&
      decisions.decisions.value.length > 0,
  });
});

/**
 * 最終確定できるか。`counts.pending`(判定バーの件数)と `pendingPartKeys`(最終候補の未判定)は
 * どちらも差分の変更パーツを `partKey` で 1 つにまとめて数えるので同じ母集団だが、確定の可否は
 * サーバと同じ候補側でも確かめる。
 */
const canFinalize = computed(
  () => decisions.pendingPartKeys.value.length === 0 && blockedReasons.value.length === 0,
);

/**
 * 最終確定・申請ごと却下の失敗。ほかの人が先に決着させた(`REVIEW_ALREADY_DECIDED`)ときは
 * 読み直して決着後の画面にし、読み直した決着を親へ伝える(一覧・件数・承認待ちの印を合わせる)。
 * その code は `useReviewDiff` がトーストを黙らせているので、ここで 1 つだけ出す。読み直しに
 * 失敗したら「読み直しました」とは言わない。ほかの失敗は `useAsyncResult` がサーバの文言を出す。
 */
async function onDecideFailed(code: string | undefined): Promise<void> {
  if (code !== REVIEW_ALREADY_DECIDED) return;
  const reloaded = await load();
  toast(
    `この申請はすでに処理されています。${reloaded ? '画面を読み直しました。' : ''}`,
    'error',
  );
  const r = review.value;
  if (reloaded && r && r.status !== 'pending') emit('decided', toReviewMeta(r));
}

async function finalize(): Promise<void> {
  if (busy.value || !canFinalize.value || counts.value.pending > 0) return;

  const accepted = await confirm({
    title: 'この申請を最終確定しますか？',
    description:
      `承認済みパーツ: ${counts.value.approved}件、` +
      `却下済みパーツ: ${counts.value.rejected}件、` +
      `未判定パーツ: ${counts.value.pending}件、` +
      `書式設定の変更: ${cssChanged.value ? 'あり' : 'なし'}。\n` +
      '最終確定後はパーツ判定を変更できません。',
    confirmLabel: '最終確定する',
    variant: 'destructive',
  });
  if (!accepted) return;

  // 申請全体の承認メモは送らない(承認の理由は書かせない。パーツの却下理由だけを残す)。
  const res = await approveReview(undefined);
  if (!isOk(res)) {
    await onDecideFailed(res.error.code);
    return;
  }
  // 申請後に現行版が変更されていた場合は上書き注意を促す(承認自体はブロックしない)。
  if (res.value.staleWarning) {
    toast(
      '承認して反映しました。ただし申請後に現行版が変更されていました（同じテンプレの他の基準日の承認で CSS が変わった場合を含みます）。上書きした可能性があります。',
      'default',
      6000,
    );
  } else {
    toastSuccess('承認しました（本番テンプレートへ反映しました）');
  }

  notifySyncResult(res.value.sync);
  notifyNoteMasterResult(res.value.noteMaster);

  // 承認の応答はテンプレートのメタしか持たない。決着後の申請は読み直して得る。
  const before = review.value;
  await load();
  emitDecided(before, {
    status: 'approved',
    reviewedBy: auth.user?.username ?? null,
    reviewedAt: new Date().toISOString(),
    comment: null,
  });
}

/**
 * 決着を親へ伝える。読み直した申請が決着済みならそれを、読み直しに失敗して承認待ちのまま
 * なら決着前の申請へ決着の内容を重ねたものを使う。承認・却下はサーバで成立しているので、
 * 承認待ちのまま伝えると一覧に決着済みの申請が承認待ちとして残り、ボタンも押せたままになる。
 * `review` は本体(html/css/filledHtml)を持つ `ReviewRequest`。一覧の親(`ReviewTabView`)は
 * メタだけを保持するので、本体を持ち越さないよう剥がしてから渡す。
 */
function emitDecided(
  before: ReviewRequest | null,
  decision: Pick<ReviewRequestMeta, 'status' | 'reviewedBy' | 'reviewedAt' | 'comment'>,
): void {
  const reloaded = review.value;
  if (reloaded && reloaded.id === before?.id && reloaded.status !== 'pending' && !loadError.value) {
    emit('decided', toReviewMeta(reloaded));
    return;
  }
  if (!before) return;
  review.value = { ...before, ...decision };
  emit('decided', toReviewMeta(review.value));
}

/**
 * 承認直後に走った交付版⇄全体版のパーツと CSS の自動同期の結果を通知する。同期はベストエフォート
 * (失敗しても承認は成立)のため、失敗・スキップは destructive/長め表示で見落としを防ぐ。
 * スキップの内訳(競合など)は同期先テンプレを開いた時のバナーが恒常表示する。
 */
function notifySyncResult(sync: ApproveReviewResult['sync']): void {
  const r = pairSyncResultText(sync);
  if (!r) return;
  toast(r.text, r.variant, r.variant === 'error' ? 8000 : 6000);
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

// ── 5. 申請ごと却下 ──

const requestRejectOpen = ref(false);
const requestRejectText = ref('');
const requestRejectError = ref(false);
const requestRejectEl = ref<HTMLTextAreaElement | null>(null);
watch(requestRejectText, (v) => {
  if (v.trim()) requestRejectError.value = false;
});

/** 申請ごと却下の理由欄をカードの先頭に開き、入力欄へ移る(見出しのリンクから呼ばれる)。 */
function openRequestReject(): void {
  requestRejectOpen.value = true;
  void nextTick().then(() => requestRejectEl.value?.focus());
}

function closeRequestReject(): void {
  requestRejectOpen.value = false;
  requestRejectText.value = '';
  requestRejectError.value = false;
}

async function submitRequestReject(): Promise<void> {
  if (busy.value) return;
  // 却下は申請者へ戻す操作 — 理由が残らないと編集者が直しようがないため必須にする。
  const reason = requestRejectText.value.trim();
  if (!reason) {
    requestRejectError.value = true;
    requestRejectEl.value?.focus();
    return;
  }
  const res = await rejectReview(reason);
  if (!isOk(res)) {
    await onDecideFailed(res.error.code);
    return;
  }
  toastSuccess('却下しました');
  closeRequestReject();
  const before = review.value;
  await load();
  const { status, reviewedBy, reviewedAt, comment } = res.value;
  emitDecided(before, { status, reviewedBy, reviewedAt, comment });
}

defineExpose({ gotoPage, selectPart, openRequestReject });

// ── 6. PDF ──

// 通知バーの「PDF を開いて確認」の生成中フラグ。ボタンを disabled にして多重クリックを防ぐ
// (`PreviewView` の `exporting` と同じパターン)。
const pdfGenerating = ref(false);

/**
 * 通知バーの「PDF を開いて確認」— 申請版 1 文書を既存の PDF 出力経路(`PreviewView` の
 * `exportPdf` と同じ `templatePreviewService.renderPdf`)で開く。対象は申請の記入済み
 * インスタンス(`review.filledHtml`)、無ければ diff 由来の申請版本文(`afterBodyHtml` +
 * `cssAfter`)。値の差込は申請側で済んでいるため `sample` は空でよい。新しい PDF
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
    // 記入済みインスタンスは描画済みの文書なので描画を通さない(理由は
    // `features/preview/services/templatePreviewService.ts` の `isFilled` の定義箇所)。
    // `filledHtml` が空文字の申請(描画中・描画失敗のまま申請)は diff 由来の申請版本文へ倒す。
    // これも `renderTemplateBody` がサンプル値で描画した後の HTML なので、同じく描画を通さない
    // (もう一度通すと、本文中の `{{` に見える文字が空の値で消える)。
    const html = review.value.filledHtml || afterBodyHtml.value;
    const res = await preview.renderPdf(
      html,
      cssAfter.value,
      {},
      false,
      true,
      companyCodeOfTemplateId(review.value.templateId),
    );
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

onMounted(load);
</script>

<template>
  <div>
    <p
      v-if="loading && !review"
      class="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 class="h-4 w-4 animate-spin" /> 前後プレビューを生成中…
    </p>
    <p v-else-if="loadError && !review" class="text-sm text-destructive">
      申請の読み込みに失敗しました。時間をおいて再度お試しください。
    </p>

    <section
      v-else-if="review && diff"
      data-review-card
      class="flex flex-col overflow-hidden"
    >
      <!-- 1. 申請ごと却下(見出しのリンクから開く例外の操作。最終確定の隣には置かない)。 -->
      <div
        v-if="requestRejectOpen && canDecide"
        data-request-reject
        class="flex flex-wrap items-start gap-3 border-b bg-destructive/5 px-3 py-2"
      >
        <div class="grid min-w-0 flex-1 gap-1">
          <label class="text-xs font-bold" :for="`request-reject-${reqId}`">
            申請ごと却下する理由（必須）
          </label>
          <textarea
            :id="`request-reject-${reqId}`"
            ref="requestRejectEl"
            v-model="requestRejectText"
            rows="2"
            placeholder="直してほしい点を書きます"
            :aria-invalid="requestRejectError || undefined"
            class="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="requestRejectError ? 'border-destructive' : 'border-input'"
          />
          <p v-if="requestRejectError" role="alert" class="text-xs text-destructive">
            理由を入力してください。
          </p>
          <p class="text-xs text-muted-foreground">何も確定せずに申請全体を申請者へ戻します</p>
        </div>
        <div class="grid gap-1.5">
          <Button
            size="sm"
            variant="outline"
            class="border-destructive/50 text-destructive"
            :disabled="busy"
            @click="submitRequestReject"
          >
            申請を却下する
          </Button>
          <Button size="sm" variant="ghost" :disabled="busy" @click="closeRequestReject">
            取消
          </Button>
        </div>
      </div>

      <!-- 2. 道具の行。ページ送り・変更のあるページ・紙面のチェックは `ReviewVisualCompare` が
           `toolbarTo` でこの行の先頭へ移す。 -->
      <div
        data-review-tools
        class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2"
      >
        <div ref="toolsEl" class="flex min-w-0 flex-1 basis-[28rem]" />
        <!-- 技術的警告(truncated / printOnlyCss / cssChanged)は 1 つの通知へ集約。 -->
        <ReviewNoticeBar
          class="basis-full"
          :css-changed="cssChanged"
          :shared-across-base-dates="review?.origin === 'edit'"
          :css-before="cssBefore"
          :css-after="cssAfter"
          :print-only-css="printOnlyCss"
          :truncated="truncated"
          :pdf-generating="pdfGenerating"
          @open-pdf="openPdf"
        />
      </div>

      <!-- 3. 作業域。高さを決め、左右それぞれの内側でスクロールする。 -->
      <div
        data-review-work
        class="grid h-[min(78vh,860px)] grid-cols-[minmax(0,1fr)_420px]"
      >
        <div class="min-h-0 min-w-0 overflow-hidden p-3">
          <ReviewVisualCompare
            ref="visualRef"
            :diff="diff"
            :changes="changes"
            :decisions="decisions.decisions.value"
            :css-before="cssBefore"
            :css-after="cssAfter"
            :is-create="isCreate"
            :company-code="companyCodeOfTemplateId(review.templateId)"
            :selected-no="selectedNo"
            :toolbar-to="toolsEl"
            @select="onPick"
          />
        </div>
        <aside class="flex min-h-0 min-w-0 flex-col border-l">
          <div role="tablist" class="flex shrink-0 border-b" aria-label="右欄の表示">
            <button
              v-for="t in SIDE_TABS"
              :key="t.id"
              type="button"
              role="tab"
              :aria-selected="sideTab === t.id"
              :data-side-tab="t.id"
              class="flex-1 border-b-2 px-3 py-2 text-[12.5px] font-bold"
              :class="
                sideTab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              "
              @click="sideTab = t.id"
            >
              {{ t.label }}
            </button>
          </div>
          <!-- 右欄の一覧は自分のスクロール容器を持つので、高さの決まった枠に置く。タブを切り替えても
               スクロール位置と書きかけを保つよう、v-show で残す。 -->
          <div v-show="sideTab === 'decisions'" role="tabpanel" class="min-h-0 flex-1">
            <ReviewDecisionList
              :key="changesKey"
              ref="listRef"
              :changes="changes"
              :decisions="decisions.decisions.value"
              :selected-no="selectedNo"
              :can-decide="canDecide"
              :busy="busy"
              @select="onPick"
              @approve="decisions.approve"
              @reject="decisions.reject"
              @undo="decisions.undo"
            />
          </div>
          <div
            v-show="sideTab === 'comments'"
            role="tabpanel"
            class="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <slot name="comments" v-bind="commentSlotProps" />
          </div>
        </aside>
      </div>

      <!-- 4. 下端の判定バー(精査者のみ・承認待ちのみ)。決着済み・閲覧のみはその旨の行。 -->
      <ReviewDecisionBar
        v-if="canDecide"
        :counts="counts"
        :next-no="nextNo"
        :blocked-reasons="blockedReasons"
        :can-finalize="canFinalize"
        :busy="busy"
        @next="selectNextPending"
        @finalize="finalize"
      />
      <div
        v-else-if="review.status !== 'pending'"
        class="border-t bg-muted/30 px-3 py-2 text-sm"
      >
        この申請は
        <span class="font-medium">
          {{ DECIDED_STATUS_LABEL[review.status as 'approved' | 'rejected'] }}
        </span>
        です（{{ review.reviewedBy }}・{{ formatDateTimeShort(review.reviewedAt) }}）。
        <span
          v-if="review.comment && review.status === 'rejected'"
          class="block text-muted-foreground"
        >
          却下理由: {{ review.comment }}
        </span>
      </div>
      <p v-else class="border-t px-3 py-2 text-sm text-muted-foreground">
        承認操作には精査者(承認者)権限が必要です。
      </p>
    </section>
  </div>
</template>
