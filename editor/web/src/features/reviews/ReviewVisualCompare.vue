<script setup lang="ts">
// =============================================================================
// ReviewVisualCompare.vue — 承認タブの左右の紙面(変更前=現行版｜変更後=申請版)
// =============================================================================
// PreviewPanel(隔離 iframe のビューアホスト)を 2 面並べ、実際の帳票と同じ組版で前後を見せる。
// 作成経路(isCreate)は比較元が無いので 1 面。本文は `buildReviewPaper` が判定・空き枠・番号の
// 属性まで組み、`buildCompareDoc` が完全文書へ包む。番号札・枠・色はホストが描く。
//
// 組み直しの範囲(計画で決めたこと 6・7): 承認・承認の取り消し・選択・ページ送りでは文書を
// 組み直さず、目印(`marks`)だけを送り直す。右面は却下したパーツだけ現行版へ戻すので、却下と
// 却下の取り消しのときだけ右面を組み直す。「紙面に変更を描く」の切り替えは両面を組み直す
// (文字の差分の class を付け外しするため)。組み直したあとは選択中のパーツへ移り直す。
//
// 紙面(テンプレ JS が番号札と同じ realm で動く)からの値は補助で、そのまま使わない。番号は
// `changes` の番号の集合で照合し、ページは子が返した物理ページ数の範囲で照合する。
import {
  buildReviewPaper,
  type ChangedPart,
  type HtmlDiff,
  type PreviewMarks,
  type ReviewPartDecision,
} from '@editor/shared';
import { computed, ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import PreviewPanel from '@/features/preview/PreviewPanel.vue';
import { defaultHtmlParser } from '@/lib/htmlParser';
import { decisionOf, rejectedSignature } from './reviewDecisionState';
import { buildCompareDoc, type CompareDoc } from './services/reviewCompareDocs';

const props = defineProps<{
  diff: HtmlDiff;
  /** 番号つきの変更パーツ(`ReviewChangeRow` を渡す)。 */
  changes: readonly ChangedPart[];
  decisions: readonly ReviewPartDecision[];
  cssBefore: string;
  cssAfter: string;
  isCreate: boolean;
  /** テンプレ ID の会社コード(会社フォルダの画像の照合用)。 */
  companyCode: string | null;
  selectedNo: number | null;
}>();

const emit = defineEmits<{ select: [no: number] }>();

const highlight = ref(true);

// ── 1. 文書 ──────────────────────────────────────────────────

/**
 * 却下のパーツキーの集合。判定が変わっても却下の顔ぶれ(`rejectedSignature`)が同じなら前の
 * 集合をそのまま返し、右面の文書を組み直させない(承認・承認の取り消しでは変わらない)。
 */
const rejected = computed<{ signature: string; keys: ReadonlySet<string> }>((previous) => {
  const signature = rejectedSignature(props.decisions);
  if (previous?.signature === signature) return previous;
  const keys = new Set(
    props.decisions.filter((d) => d.status === 'rejected').map((d) => d.partKey),
  );
  return { signature, keys };
});

// 左面は判定に依らない(却下しても現行版のまま)。右面は却下だけを見る。承認と未判定は
// 紙面の中身が同じなので `pending` と読ませる(承認で文書が変わらないことの担保)。
const beforeDoc = computed<CompareDoc | null>(() =>
  props.isCreate
    ? null
    : buildCompareDoc({
        paper: buildReviewPaper({
          diff: props.diff,
          parts: props.changes,
          decisionOf: () => 'pending',
          side: 'before',
          highlight: highlight.value,
          parse: defaultHtmlParser,
        }),
        css: props.cssBefore,
      }),
);

const afterDoc = computed<CompareDoc>(() => {
  const keys = rejected.value.keys;
  return buildCompareDoc({
    paper: buildReviewPaper({
      diff: props.diff,
      parts: props.changes,
      decisionOf: (partKey) => (keys.has(partKey) ? 'rejected' : 'pending'),
      side: 'after',
      highlight: highlight.value,
      parse: defaultHtmlParser,
    }),
    css: props.cssAfter,
  });
});

/** 自分の番号の集合(文字列)。紙面から届く番号はこれで照合する。 */
const knownNos = computed(() => new Set(props.changes.map((c) => String(c.no))));

/** 目印は毎回新しいオブジェクトで渡す(PreviewPanel の watch は参照で比べる)。 */
const marks = computed<PreviewMarks>(() => {
  const states: PreviewMarks['states'] = {};
  for (const c of props.changes) states[String(c.no)] = decisionOf(props.decisions, c.partKey);
  return {
    states,
    selected: props.selectedNo === null ? null : String(props.selectedNo),
    visible: highlight.value,
  };
});

// ── 2. 面の状態 ──────────────────────────────────────────────

interface PanelState {
  currentPage: number;
  pageCount: number;
  atFirst: boolean;
  atLast: boolean;
  ready: boolean;
}
const initialState = (): PanelState => ({
  currentPage: 1,
  pageCount: 0,
  atFirst: true,
  atLast: false,
  ready: false,
});

const beforePanel = ref<InstanceType<typeof PreviewPanel>>();
const afterPanel = ref<InstanceType<typeof PreviewPanel>>();
const beforeState = ref<PanelState>(initialState());
const afterState = ref<PanelState>(initialState());

function toPanelState(s: PanelState): PanelState {
  return {
    currentPage: s.currentPage,
    pageCount: s.pageCount,
    atFirst: s.atFirst,
    atLast: s.atLast,
    ready: s.ready,
  };
}

/** 単面表示(`isCreate`)は右面だけ、2 面表示は両面の組版が終わったか。 */
function panelsReady(): boolean {
  return afterState.value.ready && (props.isCreate || beforeState.value.ready);
}

// ── 3. 変更のあるページ(右面の物理ページ) ───────────────────────

/** 右面から返った番号 → 物理ページ(知らない番号は捨て済み)。返る前と組み直しの最中は null。 */
const afterPartPages = ref<Record<string, number> | null>(null);

function onAfterPartPages(pages: Record<string, number>): void {
  const known = knownNos.value;
  afterPartPages.value = Object.fromEntries(Object.entries(pages).filter(([no]) => known.has(no)));
}

/**
 * 変更のあるページ(0 始まり、昇順)。ページ数以上の値は捨てる。ページ数(物理)は飾りのあとの
 * 状態通知で届くので、受けたときでなく出すときに照合する。
 */
const changedPages = computed<number[]>(() => {
  const pages = afterPartPages.value;
  if (pages === null || !afterState.value.ready) return [];
  const count = afterState.value.pageCount;
  return [...new Set(Object.values(pages).filter((p) => p < count))].sort((a, b) => a - b);
});

// ── 4. 移動 ──────────────────────────────────────────────────

/** ページ送りは左右へ同時に送る(片面が短い場合は末尾で止まるだけ)。 */
function prev(): void {
  beforePanel.value?.prevPage();
  afterPanel.value?.prevPage();
}
function next(): void {
  beforePanel.value?.nextPage();
  afterPanel.value?.nextPage();
}

/** 物理ページ(0 始まり)へ左右とも送る。 */
function goToPhysicalPage(index: number): void {
  beforePanel.value?.goToPage(index + 1);
  afterPanel.value?.goToPage(index + 1);
}

/**
 * 組版の終わりを待っている移動。組み直しの最中・開いた直後に呼ばれたものをここへ積み、
 * 両面の `ready` が戻ったところで送る(最新勝ち)。簡易表示へ倒れた面は `ready` が戻らないので
 * 送られないまま残り、次の操作で上書きされる。
 */
const pendingPart = ref<number | null>(null);
const pendingPageIndex = ref<number | null>(null);

function sendGotoPart(no: number): void {
  beforePanel.value?.gotoPart(String(no));
  afterPanel.value?.gotoPart(String(no));
}

/** パーツの最初の断片のページへ左右とも移る。知らない番号は無視する。 */
function gotoPart(no: number): void {
  if (!knownNos.value.has(String(no))) return;
  if (!panelsReady()) {
    pendingPart.value = no;
    return;
  }
  sendGotoPart(no);
}

function sendGotoPage(index: number): void {
  const beforeId = beforeDoc.value?.pageAnchors[index];
  const afterId = afterDoc.value.pageAnchors[index];
  if (beforeId) beforePanel.value?.gotoAnchor(beforeId);
  if (afterId) afterPanel.value?.gotoAnchor(afterId);
}

/**
 * 論理ページ(0 始まり。確定版の改ページで数えた index)の先頭へ両面を送る。承認タブの
 * コメント一覧が「行から該当ページへ」に使う。物理ページの番号で送ると溢れた帳票でずれるので、
 * ページの先頭要素のアンカー(`buildCompareDoc` の `pageAnchors`)で送る。
 */
function gotoPage(index: number): void {
  if (!panelsReady()) {
    pendingPageIndex.value = index;
    return;
  }
  sendGotoPage(index);
}

watch([afterState, beforeState], () => {
  if (!panelsReady()) return;
  if (pendingPart.value !== null) {
    const no = pendingPart.value;
    pendingPart.value = null;
    if (knownNos.value.has(String(no))) sendGotoPart(no);
  }
  if (pendingPageIndex.value !== null) {
    const index = pendingPageIndex.value;
    pendingPageIndex.value = null;
    sendGotoPage(index);
  }
});

// 文書を組み直したら、物理ページの対応を捨てて返り直しを待ち、選択中のパーツへ移り直す。
watch(
  [beforeDoc, afterDoc],
  ([b, a], [oldB, oldA]) => {
    if (a !== oldA) {
      afterPartPages.value = null;
      afterState.value = { ...afterState.value, ready: false };
    }
    if (b !== oldB) beforeState.value = { ...beforeState.value, ready: false };
    if (props.selectedNo !== null) pendingPart.value = props.selectedNo;
  },
  { flush: 'sync' },
);
if (props.selectedNo !== null) pendingPart.value = props.selectedNo;

/** 紙面のパーツの押下。知らない番号(テンプレ JS が偽れる)は無視する。 */
function onPartClick(no: string): void {
  if (knownNos.value.has(no)) emit('select', Number(no));
}

defineExpose({ gotoPart, gotoPage });
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        aria-label="前のページ"
        :disabled="afterState.atFirst"
        data-page-prev
        @click="prev"
      >
        ‹
      </Button>
      <span class="text-xs text-muted-foreground" data-page-indicator>
        {{ afterState.currentPage }} / {{ afterState.pageCount || '?' }} ページ
      </span>
      <Button
        variant="outline"
        size="sm"
        aria-label="次のページ"
        :disabled="afterState.atLast"
        data-page-next
        @click="next"
      >
        ›
      </Button>
      <span
        v-if="changedPages.length > 0"
        class="flex items-center gap-1 text-xs text-muted-foreground"
        data-changed-pages
      >
        変更のあるページ:
        <template v-for="(page, i) in changedPages" :key="page">
          <span v-if="i > 0" aria-hidden="true">・</span>
          <button
            type="button"
            class="cursor-pointer text-accent-foreground underline"
            :data-changed-page="page + 1"
            @click="goToPhysicalPage(page)"
          >
            {{ page + 1 }}
          </button>
        </template>
      </span>
      <label class="ml-auto flex cursor-pointer items-center gap-1.5">
        <Checkbox v-model="highlight" data-highlight-toggle />
        <span class="text-xs">紙面に変更を描く（番号と文字の差分）</span>
      </label>
    </div>
    <div class="grid gap-3" :class="isCreate ? '' : 'md:grid-cols-2'">
      <figure v-if="!isCreate && beforeDoc" class="min-w-0 space-y-1">
        <figcaption class="text-xs font-medium text-muted-foreground">変更前（現行版）</figcaption>
        <div class="h-[70vh] overflow-hidden rounded border">
          <PreviewPanel
            ref="beforePanel"
            :html="beforeDoc.doc"
            :company-code="companyCode"
            :marks="marks"
            data-side="before"
            @state="(s) => (beforeState = toPanelState(s))"
            @part-click="onPartClick"
          />
        </div>
      </figure>
      <figure class="min-w-0 space-y-1">
        <figcaption class="text-xs font-medium text-accent-foreground">
          <template v-if="isCreate">申請内容</template>
          <template v-else>
            変更後（申請版）
            <span class="ml-1 font-normal text-muted-foreground">
              申請された内容。却下したパーツだけ現行版に戻して表示
            </span>
          </template>
        </figcaption>
        <div class="h-[70vh] overflow-hidden rounded border">
          <PreviewPanel
            ref="afterPanel"
            :html="afterDoc.doc"
            :company-code="companyCode"
            :marks="marks"
            data-side="after"
            @state="(s) => (afterState = toPanelState(s))"
            @part-click="onPartClick"
            @part-pages="onAfterPartPages"
          />
        </div>
      </figure>
    </div>
  </div>
</template>
