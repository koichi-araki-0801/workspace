<script setup lang="ts">
// =============================================================================
// ReviewDecisionList.vue — 承認タブ右欄「変更と判定」(番号順の行・まとめて判定の帯・表示窓)
// =============================================================================
// 行は `[start, end)` の窓だけを描き、上下は見込み高の空 `div`(番兵を兼ねる)で埋める(設計書 D8)。
// 窓の上端で行を足す・外すときは、見えている行が動かないよう `scrollTop` を補う。量の計算は
// `reviewDecisionList.ts` の純関数で、ここは DOM の測定と書き込みだけを持つ。
// まとめて判定の選択は行番号の集合で持ち、描画と切り離す(窓の外の行でも選択を保つ)。
// 判定は emit するだけで、保存の成否は `decisions` の更新で知る(届いたパーツを選択から外す)。
import type { PaperDecision, ReviewPartDecision } from '@editor/shared';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import ReviewDecisionRow from './ReviewDecisionRow.vue';
import {
  clampWindow,
  growDown,
  growUp,
  initialWindow,
  REJECT_REASON_MAX,
  ROW_HEIGHT_ESTIMATE,
  type RowWindow,
  reasonLength,
  rejectReasonProblem,
  scrollDelta,
  windowAround,
} from './reviewDecisionList';
import type { ReviewChangeRow } from './services/reviewDiffService';

const props = defineProps<{
  changes: ReviewChangeRow[];
  decisions: ReviewPartDecision[];
  selectedNo: number | null;
  canDecide: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  select: [no: number];
  approve: [partKeys: string[]];
  reject: [partKeys: string[], reason: string];
  undo: [partKey: string];
}>();

// ── 1. 行と判定 ──

const rows = computed(() => [...props.changes].sort((a, b) => a.no - b.no));
const decisionByKey = computed(() => new Map(props.decisions.map((d) => [d.partKey, d])));

function statusOf(c: ReviewChangeRow): PaperDecision {
  return decisionByKey.value.get(c.partKey)?.status ?? 'pending';
}

function reasonOf(c: ReviewChangeRow): string | null {
  return decisionByKey.value.get(c.partKey)?.comment ?? null;
}

const pendingNos = computed(() =>
  rows.value.filter((c) => statusOf(c) === 'pending').map((c) => c.no),
);

// ── 2. まとめて判定 ──

const picked = ref(new Set<number>());
const pickedKeys = computed(() =>
  rows.value.filter((c) => picked.value.has(c.no)).map((c) => c.partKey),
);
const pickedCount = computed(() => pickedKeys.value.length);
const allPendingPicked = computed(
  () => pendingNos.value.length > 0 && pendingNos.value.every((no) => picked.value.has(no)),
);

// 判定が届いた(未判定でなくなった)パーツと、変更から消えたパーツは選択から外す。
watch(pendingNos, (nos) => {
  const keep = new Set(nos);
  const next = new Set([...picked.value].filter((no) => keep.has(no)));
  if (next.size !== picked.value.size) picked.value = next;
  // 判定が届いたパーツの書きかけの理由も捨てる(窓の外で届くと行は閉じる機会が無い)。
  const pendingKeys = new Set(
    rows.value.filter((c) => keep.has(c.no)).map((c) => c.partKey),
  );
  const drafts = new Map([...rejectDrafts.value].filter(([key]) => pendingKeys.has(key)));
  if (drafts.size !== rejectDrafts.value.size) rejectDrafts.value = drafts;
});

// ── 2a. 1 行の却下の書きかけ ──
// 行は表示窓から外れると壊れるので、理由欄の開閉と書きかけは partKey ごとにここで持ち、行が
// 窓へ戻ったら返す。閉じて空になったものは消す。

interface RejectDraft {
  open: boolean;
  text: string;
}

const rejectDrafts = ref(new Map<string, RejectDraft>());

function draftOf(key: string): RejectDraft {
  return rejectDrafts.value.get(key) ?? { open: false, text: '' };
}

function setDraft(key: string, patch: Partial<RejectDraft>) {
  const next = { ...draftOf(key), ...patch };
  const m = new Map(rejectDrafts.value);
  if (!next.open && !next.text) m.delete(key);
  else m.set(key, next);
  rejectDrafts.value = m;
}

function setPicked(no: number, value: boolean) {
  const next = new Set(picked.value);
  if (value) next.add(no);
  else next.delete(no);
  picked.value = next;
}

function onPickAll(e: Event) {
  picked.value = (e.target as HTMLInputElement).checked ? new Set(pendingNos.value) : new Set();
}

const bulkOpen = ref(false);
const bulkDraft = ref('');
const bulkEmptyError = ref(false);
const bulkTooLong = computed(() => rejectReasonProblem(bulkDraft.value) === 'tooLong');
// まとめて却下の理由欄と注意の id。承認タブは申請カードを 2 枚まで並べるので部品ごとに振る。
const bulkId = useId();
const bulkDescribedBy = computed(() =>
  [bulkEmptyError.value && `${bulkId}-empty`, bulkTooLong.value && `${bulkId}-long`, `${bulkId}-note`]
    .filter(Boolean)
    .join(' '),
);

watch(pickedCount, (n) => {
  if (n === 0) closeBulk();
});
watch(bulkDraft, (v) => {
  if (v.trim()) bulkEmptyError.value = false;
});

function closeBulk() {
  bulkOpen.value = false;
  bulkDraft.value = '';
  bulkEmptyError.value = false;
}

function approvePicked() {
  emit('approve', pickedKeys.value);
}

function submitBulkReject() {
  const problem = rejectReasonProblem(bulkDraft.value);
  if (problem === 'empty') bulkEmptyError.value = true;
  if (problem !== null) return;
  emit('reject', pickedKeys.value, bulkDraft.value.trim());
}

// ── 3. 表示窓 ──

const win = ref<RowWindow>(initialWindow(props.changes.length));
const visibleRows = computed(() => rows.value.slice(win.value.start, win.value.end));
const topSpace = computed(() => win.value.start * ROW_HEIGHT_ESTIMATE);
const bottomSpace = computed(() => (rows.value.length - win.value.end) * ROW_HEIGHT_ESTIMATE);

const scroller = ref<HTMLElement | null>(null);
const band = ref<HTMLElement | null>(null);
const topEl = ref<HTMLElement | null>(null);
const bottomEl = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
/** 窓を動かして補正を終えるまでは、次の番兵の通知を受けない。 */
let moving = false;
/** 送りの途中の `revealNo` の数。0 でない間も番兵の通知を受けない(続けて呼ばれても数で戻す)。 */
let revealing = 0;

watch(
  () => rows.value.length,
  (total) => {
    win.value = clampWindow(win.value, total);
  },
);

function renderedRowEls(): HTMLElement[] {
  return Array.from(scroller.value?.querySelectorAll<HTMLElement>('[data-review-row-no]') ?? []);
}

/**
 * 行の実高。`offsetHeight` は整数に丸めるので使わない — 行が 92.5px のような小数の高さだと 1 行
 * 0.5px ずつ補正が欠け、50 行で 25px ずれた(Task 14 の e2e)。
 */
function heightsOf(els: HTMLElement[]): number[] {
  return els.map((el) => el.getBoundingClientRect().height);
}

async function extendDown() {
  const { next, droppedTop } = growDown(win.value, rows.value.length);
  if (next.end === win.value.end) return;
  // 外す行の実高は、外す直前に測る(外したあとは見込み高の余白に置き換わる)。
  const dropped = heightsOf(renderedRowEls().slice(0, droppedTop));
  win.value = next;
  await nextTick();
  if (droppedTop > 0 && scroller.value) scroller.value.scrollTop -= scrollDelta(dropped);
}

async function extendUp() {
  const { next, addedTop } = growUp(win.value);
  if (addedTop === 0) return;
  win.value = next;
  await nextTick();
  // 足した行の実高は、描いた直後に測る。
  const added = heightsOf(renderedRowEls().slice(0, addedTop));
  if (scroller.value) scroller.value.scrollTop += scrollDelta(added);
}

async function onIntersect(entries: IntersectionObserverEntry[]) {
  if (moving || revealing > 0) return;
  const hit = entries.find((e) => e.isIntersecting);
  if (!hit) return;
  moving = true;
  try {
    if (hit.target === bottomEl.value) await extendDown();
    else if (hit.target === topEl.value) await extendUp();
  } finally {
    moving = false;
  }
}

/**
 * 番兵の観測を窓に合わせ直す。上の番兵は `start > 0` のときだけ観測する(先頭まで描いているのに
 * 見えて空回りしないように)。観測し直すと、番兵がまだ見えていれば IO が改めて通知するので、
 * 行が低くて 1 回の足し分で埋まらないときも続けて広がる。
 */
function syncObservation() {
  const io = observer;
  if (!io) return;
  for (const el of [topEl.value, bottomEl.value]) if (el) io.unobserve(el);
  if (topEl.value && win.value.start > 0) io.observe(topEl.value);
  if (bottomEl.value && win.value.end < rows.value.length) io.observe(bottomEl.value);
}

watch([() => win.value.start, () => win.value.end, () => rows.value.length], syncObservation, {
  flush: 'post',
});

onMounted(() => {
  observer = new IntersectionObserver((entries) => void onIntersect(entries), {
    root: scroller.value,
    rootMargin: '200px 0px',
  });
  syncObservation();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

/**
 * 番号 `no` の行を見える位置へ送る。窓の外なら、途中を描かずに窓を `[no-50, no+50)` へ移す。
 * 送り終えるまで番兵の通知は受けない(`revealing`)。受けると、窓を広げたときの `scrollTop` の補正が
 * 送ったあとに走り、送った行が見える位置からずれる。受けなかった通知の代わりに、送ったあとに
 * 番兵を観測し直す(まだ見えていれば IO が改めて通知する)。
 */
async function revealNo(no: number): Promise<void> {
  const i = rows.value.findIndex((c) => c.no === no);
  if (i < 0) return;
  revealing++;
  try {
    if (i < win.value.start || i >= win.value.end) {
      win.value = windowAround(i, rows.value.length);
    }
    await nextTick();
    const el = scroller.value?.querySelector<HTMLElement>(`[data-review-row-no="${no}"]`);
    if (!el) return;
    // sticky の帯の下へ隠れないよう、送る直前の帯の高さを行の上の余白にする(帯は理由欄の開閉で
    // 高さが変わるので固定値にしない)。
    el.style.scrollMarginTop = `${band.value?.offsetHeight ?? 0}px`;
    el.scrollIntoView({ block: 'nearest' });
  } finally {
    revealing--;
    if (revealing === 0) syncObservation();
  }
}

defineExpose({ revealNo });
</script>

<template>
  <!-- `overflow-anchor: none`: ブラウザのスクロールアンカリングと手での `scrollTop` の補正が
       二重に効いて行が飛ぶのを防ぐ(補正は窓を動かす側だけが持つ)。 -->
  <div
    ref="scroller"
    data-review-scroller
    class="h-full overflow-y-auto [overflow-anchor:none]"
  >
    <div v-if="canDecide" ref="band" data-review-band class="sticky top-0 z-10 grid gap-2 border-b bg-card px-3.5 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs">
          <input
            type="checkbox"
            data-review-pick-all
            class="h-3.5 w-3.5 cursor-pointer accent-primary"
            :checked="allPendingPicked"
            :disabled="pendingNos.length === 0"
            @change="onPickAll"
          />
          未判定をすべて選ぶ
        </label>
        <span class="ml-auto inline-flex items-center gap-1.5">
          <span class="whitespace-nowrap text-xs text-muted-foreground"
            >{{ pickedCount }} 件選択中</span
          >
          <Button size="sm" :disabled="busy || pickedCount === 0" @click="approvePicked"
            >まとめて承認</Button
          >
          <Button
            size="sm"
            variant="outline"
            class="border-destructive/50 text-destructive"
            :disabled="busy || pickedCount === 0"
            @click="bulkOpen = true"
            >まとめて却下…</Button
          >
        </span>
      </div>
      <div
        v-if="bulkOpen && pickedCount > 0"
        data-review-bulk-reject
        class="grid gap-1 rounded-md bg-destructive/10 px-2.5 py-2"
      >
        <label class="text-xs font-bold" :for="bulkId"
          >選んだパーツを却下する理由（必須）</label
        >
        <textarea
          :id="bulkId"
          v-model="bulkDraft"
          rows="2"
          placeholder="同じ理由を、選んだパーツそれぞれの却下理由として保存します"
          :aria-invalid="bulkEmptyError || bulkTooLong || undefined"
          :aria-describedby="bulkDescribedBy"
          class="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="bulkEmptyError || bulkTooLong ? 'border-destructive' : 'border-input'"
        />
        <p v-if="bulkEmptyError" :id="`${bulkId}-empty`" role="alert" class="text-xs text-destructive">
          理由を入力してください。
        </p>
        <p v-if="bulkTooLong" :id="`${bulkId}-long`" role="alert" class="text-xs text-destructive">
          理由は {{ REJECT_REASON_MAX }} 文字までです（いま {{ reasonLength(bulkDraft) }} 文字）。
        </p>
        <p :id="`${bulkId}-note`" class="text-xs text-muted-foreground">
          理由はパーツごとに 1 件ずつ保存し、申請者の編集画面に表示します。
        </p>
        <div class="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" @click="closeBulk">取消</Button>
          <Button
            size="sm"
            variant="outline"
            class="border-destructive/50 text-destructive"
            :disabled="busy || bulkTooLong"
            @click="submitBulkReject"
            >{{ pickedCount }} 件を却下する</Button
          >
        </div>
      </div>
    </div>

    <p class="px-3.5 py-1.5 text-xs text-muted-foreground">
      文字の変更は、申請者のスタイルに影響されない本文の照合です。確定・保存されるのはこの差分です。
    </p>

    <div ref="topEl" data-review-sentinel="top" aria-hidden="true" :style="{ height: `${topSpace}px` }" />
    <ul>
      <ReviewDecisionRow
        v-for="c in visibleRows"
        :key="c.partKey"
        :change="c"
        :status="statusOf(c)"
        :reason="reasonOf(c)"
        :can-decide="canDecide"
        :busy="busy"
        :selected="c.no === selectedNo"
        :picked="picked.has(c.no)"
        :reject-open="draftOf(c.partKey).open"
        :draft="draftOf(c.partKey).text"
        @update:reject-open="(open) => setDraft(c.partKey, { open })"
        @update:draft="(text) => setDraft(c.partKey, { text })"
        @select="emit('select', c.no)"
        @pick="(v) => setPicked(c.no, v)"
        @approve="emit('approve', [c.partKey])"
        @reject="(reason) => emit('reject', [c.partKey], reason)"
        @undo="emit('undo', c.partKey)"
      />
    </ul>
    <div
      ref="bottomEl"
      data-review-sentinel="bottom"
      aria-hidden="true"
      :style="{ height: `${bottomSpace}px` }"
    />
  </div>
</template>
