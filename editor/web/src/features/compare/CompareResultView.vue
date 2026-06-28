<script setup lang="ts">
// =============================================================================
// CompareResultView.vue — 版比較の結果画面(ページ単位の差分を左右並列で表示)
// =============================================================================
// ページ対応は既定で比較元 i ↔ 比較先 i だが、版間でページが挿入/削除されると以降が
// ずれて読めなくなる。そこで各ページ行に対し比較元・比較先を独立に「ずらす」操作を持ち、
// 指定ページ同士を並べられるようにする。ずらしは Worker(`buildHtmlDiffAligned`)での
// 再 diff で反映し、設定は一時的(画面を離れる/再比較で破棄)。
import { type TemplateVersionMeta, toAppError } from '@editor/shared';
import { ChevronLeft, ChevronRight, RotateCcw } from '@lucide/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import PageNav from '@/components/PageNav.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import Select from '@/components/ui/Select.vue';
import { logError } from '@/lib/appError';
import { formatDateTimeShort } from '@/lib/format';
import { htmlWorker } from '@/workers';
import {
  HL_ADDED,
  HL_CHANGED,
  HL_DEL,
  HL_INS,
  HL_REMOVED,
  type HtmlDiff,
  type PagePair,
} from './htmlBlockDiff';

const props = defineProps<{
  before: TemplateVersionMeta; // ファイルA(左)
  after: TemplateVersionMeta; // ファイルB(右)
  beforeFile: string; // ファイルA のファイル名
  afterFile: string; // ファイルB のファイル名
  diff: HtmlDiff;
  cssBefore: string;
  cssAfter: string;
  beforeHtml: string; // ページずらしの再 diff 用(レンダリング済み比較元 HTML)
  afterHtml: string; // 同上(比較先)
}>();

const emit = defineEmits<{ back: [] }>();

// 現在表示中の diff(初期 = 親が計算した恒等対応。ずらし操作のたびに差し替える)。
const liveDiff = ref<HtmlDiff>(props.diff);

// ── ページナビゲーション(行 = liveDiff のページ) ──────────────────────────
// 最初の変更ありページを開く(無ければ先頭)。
const firstChanged = props.diff.pages.findIndex((p) => p.changed);
const currentPage = ref(firstChanged >= 0 ? firstChanged : 0);
const pageCount = computed(() => liveDiff.value.pages.length);
const page = computed(() => liveDiff.value.pages[currentPage.value] ?? null);

function goPage(i: number) {
  currentPage.value = Math.min(Math.max(i, 0), Math.max(pageCount.value - 1, 0));
}

// ── ページずらし状態(一時的) ──────────────────────────────────────────────
// 行 i の対応ページ index = i + offset[i]。範囲外は null(=対応なし)。オフセットで
// 持つことで「null を含む行のずらし」も連動・局所ともに破綻なく扱える。
type Side = 'before' | 'after';
const beforeCount = computed(() => props.diff.beforePageCount);
const afterCount = computed(() => props.diff.afterPageCount);
// 行数はどちらか多い方。恒等時に全ページが 1 行ずつ並ぶ。
const rowCount = computed(() => Math.max(beforeCount.value, afterCount.value, 1));

const beforeOff = ref<number[]>(Array(rowCount.value).fill(0));
const afterOff = ref<number[]>(Array(rowCount.value).fill(0));
// チェック ON のとき、ずらしボタンは「このページだけ」。OFF のとき以降の行も連動。
const localOnly = ref(false);

function sideOff(side: Side): number[] {
  return side === 'before' ? beforeOff.value : afterOff.value;
}
function sideCount(side: Side): number {
  return side === 'before' ? beforeCount.value : afterCount.value;
}
/** 行 r の当該側ソースページ index(範囲外は null)。 */
function idxOf(side: Side, r: number): number | null {
  const v = r + (sideOff(side)[r] ?? 0);
  return v >= 0 && v < sideCount(side) ? v : null;
}

// ── 現在の対応付けから pairs を組んで Worker で再 diff ──────────────────────
// 行 index と表示ページ index を一致させるため、両側 null の行も間引かず常に rowCount 件。
function buildPairs(): PagePair[] {
  const pairs: PagePair[] = [];
  for (let i = 0; i < rowCount.value; i++) {
    pairs.push({ before: idxOf('before', i), after: idxOf('after', i) });
  }
  return pairs;
}

// 連打時は最後の操作だけ反映する(古い結果で上書きしないトークンガード)。
let realignToken = 0;
const realigning = ref(false);
async function realign() {
  const token = ++realignToken;
  realigning.value = true;
  try {
    const next = await htmlWorker.buildHtmlDiffAligned(
      props.beforeHtml,
      props.afterHtml,
      props.cssBefore,
      props.cssAfter,
      buildPairs(),
    );
    if (token !== realignToken) return; // 後発の操作が走っているので破棄
    liveDiff.value = next;
    currentPage.value = Math.min(currentPage.value, Math.max(next.pages.length - 1, 0));
  } catch (e) {
    if (token === realignToken) logError(toAppError(e));
  } finally {
    if (token === realignToken) realigning.value = false;
  }
}

// ── ずらし操作 ────────────────────────────────────────────────────────────
function shift(side: Side, delta: number) {
  const off = sideOff(side);
  const r = currentPage.value;
  if (localOnly.value) {
    off[r] = (off[r] ?? 0) + delta; // このページだけ
  } else {
    for (let j = r; j < off.length; j++) off[j] = (off[j] ?? 0) + delta; // 以降も連動
  }
  realign();
}

// プルダウン直接指定(そのページだけ。連動しない)。値は 0 起点 index か null(対応なし)。
function setDirect(side: Side, value: number | null) {
  const off = sideOff(side);
  const r = currentPage.value;
  // 対応なしは確実に範囲外へ(idx = -1)。ページ指定は idx = value になるよう offset を置く。
  off[r] = value == null ? -r - 1 : value - r;
  realign();
}

function resetAlign() {
  beforeOff.value = Array(rowCount.value).fill(0);
  afterOff.value = Array(rowCount.value).fill(0);
  realign();
}

const isAligned = computed(
  () => beforeOff.value.some((o) => o !== 0) || afterOff.value.some((o) => o !== 0),
);

// ── プルダウン(現在ページ行の対応ページ選択) ──────────────────────────────
const NONE = 'none';
function pageOptions(side: Side): { label: string; value: string }[] {
  const opts: { label: string; value: string }[] = [];
  for (let p = 0; p < sideCount(side); p++) opts.push({ label: `p${p + 1}`, value: String(p) });
  opts.push({ label: '対応なし', value: NONE });
  return opts;
}
const beforeOptions = computed(() => pageOptions('before'));
const afterOptions = computed(() => pageOptions('after'));
function selModel(side: Side) {
  return computed<string>({
    get() {
      const i = idxOf(side, currentPage.value);
      return i == null ? NONE : String(i);
    },
    set(v: string) {
      setDirect(side, v === NONE ? null : Number(v));
    },
  });
}
const beforeSel = selModel('before');
const afterSel = selModel('after');

// テンプレート CSS と差分ハイライトを内包した `iframe` ドキュメントを組み立てる。
// ブロック級(要素まるごと)は左帯+淡い背景、語句級(テキスト中)は前景の下線で区別する
// (挿入=緑下線 / 削除=赤下線。打消線は使わず色で挿入・削除を分ける)。語句級は要素級と
// 入れ子になっても潰れないよう前景寄りの強調にしている。
const HIGHLIGHT_CSS = `
  body{margin:0;padding:18px;background:#fff;}
  .${HL_CHANGED}{background:rgba(220,38,38,.06)!important;box-shadow:inset 3px 0 0 #dc2626;}
  .${HL_ADDED}{background:rgba(22,163,74,.08)!important;box-shadow:inset 3px 0 0 #16a34a;}
  .${HL_REMOVED}{background:rgba(217,119,6,.08)!important;box-shadow:inset 3px 0 0 #d97706;}
  .${HL_INS}{background:rgba(22,163,74,.18);color:#15803d;text-decoration:underline;border-radius:2px;}
  .${HL_DEL}{background:rgba(220,38,38,.14);color:#b91c1c;text-decoration:underline;border-radius:2px;}
`;
function buildDoc(fragment: string, css: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><style>${css}</style><style>${HIGHLIGHT_CSS}</style></head><body>${fragment}</body></html>`;
}

const beforeDoc = computed(() => buildDoc(page.value?.beforeHtml ?? '', props.cssBefore));
const afterDoc = computed(() => buildDoc(page.value?.afterHtml ?? '', props.cssAfter));

// `iframe` を中身の高さに合わせる(srcdoc は同一オリジンなので `contentDocument` 可)。
function fitTo(f: HTMLIFrameElement | null | undefined) {
  if (!f) return;
  try {
    const h = f.contentDocument?.body?.scrollHeight;
    if (h) f.style.height = `${h + 4}px`;
  } catch {
    /* ignore */
  }
}
// `@load` 時の初回フィット。同時に、幅が変わると中身が再フローして高さも変わるため、
// `<iframe>` 自身を `ResizeObserver` で監視して以降の幅変化(ウィンドウ/ペインのリサイズ、
// `md:grid-cols-2` の折返し)にも追随させる。
const frameObservers = new WeakMap<HTMLIFrameElement, ResizeObserver>();
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

// クリーンアップ用に監視中の `iframe` を保持(`WeakMap` は列挙できないため)。
const observed: HTMLIFrameElement[] = [];
onBeforeUnmount(() => {
  for (const f of observed) frameObservers.get(f)?.disconnect();
  observed.length = 0;
});
</script>

<template>
  <div class="space-y-4">
    <!-- 上部バー -->
    <div class="flex flex-wrap items-center gap-3 border-b pb-3">
      <Button variant="outline" size="sm" @click="emit('back')">
        <ChevronLeft class="h-4 w-4" /> 選択に戻る
      </Button>
      <span class="text-lg font-bold">ファイルの比較</span>
      <span class="mono text-xs text-muted-foreground">比較元: {{ beforeFile }}　↔　比較先: {{ afterFile }}</span>
      <div class="ml-auto flex items-center gap-3">
        <span
          class="rounded-full px-2 py-0.5 text-xs font-medium"
          :class="liveDiff.changedPageCount ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'"
        >
          変更ありページ: {{ liveDiff.changedPageCount }} / {{ pageCount }}
        </span>
        <span class="flex items-center gap-1 text-xs text-muted-foreground">
          <span class="inline-block h-1.5 w-1.5 rounded-full bg-destructive" /> = 変更あり
        </span>
      </div>
    </div>

    <!-- ページナビゲータ。少数ページは変更マーク付きタブのまま(視認性優先)、多ページ
         (400 ページ規模など)はタブが破綻するため番号ジャンプ入力の共通 `PageNav` へ切替える。
         `PageNav` は 1 起点、比較の `currentPage` は 0 起点なので `go` を -1 して渡す。 -->
    <div class="flex items-center justify-center gap-2">
      <template v-if="pageCount <= 12">
        <Button variant="outline" size="icon" :disabled="currentPage <= 0" @click="goPage(currentPage - 1)">
          <ChevronLeft class="h-4 w-4" />
        </Button>
        <button
          v-for="(p, i) in liveDiff.pages"
          :key="i"
          type="button"
          class="relative min-w-9 rounded px-3 py-1 text-sm font-medium transition-colors"
          :class="i === currentPage ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-accent'"
          @click="goPage(i)"
        >
          {{ i + 1 }}
          <span
            v-if="p.changed"
            class="absolute -bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-destructive"
          />
        </button>
        <Button
          variant="outline"
          size="icon"
          :disabled="currentPage >= pageCount - 1"
          @click="goPage(currentPage + 1)"
        >
          <ChevronRight class="h-4 w-4" />
        </Button>
      </template>
      <PageNav
        v-else
        variant="outline"
        :current-page="currentPage + 1"
        :page-count="pageCount"
        @go="goPage($event - 1)"
      />
    </div>

    <!-- ページ対応(ずらし)操作: 現在ページ行の比較元・比較先を独立に指定 -->
    <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div class="flex items-center gap-1.5">
        <span class="text-xs text-muted-foreground">比較元</span>
        <Select v-model="beforeSel" :options="beforeOptions" class="h-8 w-24" />
        <Button variant="outline" size="sm" class="h-8 px-2" @click="shift('before', -1)">
          <ChevronLeft class="h-3.5 w-3.5" /> ずらす
        </Button>
        <Button variant="outline" size="sm" class="h-8 px-2" @click="shift('before', 1)">
          戻す <ChevronRight class="h-3.5 w-3.5" />
        </Button>
      </div>

      <span class="text-muted-foreground">↔</span>

      <div class="flex items-center gap-1.5">
        <span class="text-xs text-muted-foreground">比較先</span>
        <Select v-model="afterSel" :options="afterOptions" class="h-8 w-24" />
        <Button variant="outline" size="sm" class="h-8 px-2" @click="shift('after', -1)">
          <ChevronLeft class="h-3.5 w-3.5" /> ずらす
        </Button>
        <Button variant="outline" size="sm" class="h-8 px-2" @click="shift('after', 1)">
          戻す <ChevronRight class="h-3.5 w-3.5" />
        </Button>
      </div>

      <label class="flex cursor-pointer items-center gap-1.5">
        <Checkbox v-model="localOnly" />
        <span class="text-xs">このページだけ</span>
      </label>

      <Button variant="ghost" size="sm" class="h-8 px-2" :disabled="!isAligned" @click="resetAlign">
        <RotateCcw class="h-3.5 w-3.5" /> リセット
      </Button>

      <span v-if="realigning" class="text-xs text-muted-foreground">再計算中…</span>
    </div>

    <!-- 現在のページ -->
    <div v-if="page" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-[15px] font-bold">ページ {{ currentPage + 1 }}・概要</h3>
        <template v-if="page.changed">
          <span class="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            変更あり
          </span>
          <span class="text-xs text-muted-foreground">変更ブロック {{ page.changedBlockCount }} 箇所</span>
        </template>
        <span v-else class="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          変更なし
        </span>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        <figure class="space-y-1.5">
          <figcaption class="text-xs text-muted-foreground">
            比較元・{{ beforeFile }}・{{ formatDateTimeShort(before.timestamp) }}・{{ before.user }}
          </figcaption>
          <div class="overflow-hidden rounded border bg-white">
            <iframe
              :srcdoc="beforeDoc"
              title="比較元"
              class="block w-full"
              style="height: 600px; border: 0"
              @load="fitFrame"
            />
          </div>
        </figure>
        <figure class="space-y-1.5">
          <figcaption class="text-xs text-muted-foreground">
            比較先・{{ afterFile }}・{{ formatDateTimeShort(after.timestamp) }}・{{ after.user }}
          </figcaption>
          <div class="overflow-hidden rounded border bg-white">
            <iframe
              :srcdoc="afterDoc"
              title="比較先"
              class="block w-full"
              style="height: 600px; border: 0"
              @load="fitFrame"
            />
          </div>
        </figure>
      </div>
    </div>
  </div>
</template>
