<script setup lang="ts">
// =============================================================================
// PreviewPanel.vue — @vivliostyle/core によるページ送りプレビュー(iframe フォールバック付き)
// =============================================================================
// ページ送り/ズームの操作 UI は持たず, 状態は `state` イベントで親(`PreviewView`)へ上げ,
// 命令は `defineExpose` で公開する。UI は編集画面(`EditorTopBar`)と揃えて上部バーへ集約する。
import { toAppError } from '@editor/shared';
import { Loader2 } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { logError } from '@/lib/appError';

const props = defineProps<{ html: string }>();

/** 親(上部バー)へ渡すページ送り/ズーム状態のスナップショット。 */
const emit = defineEmits<{
  state: [
    {
      currentPage: number;
      pageCount: number;
      atFirst: boolean;
      atLast: boolean;
      zoom: number;
      /** vivliostyle 描画中(= ズーム/ページ送り可)。iframe フォールバック時は false。 */
      vivlioReady: boolean;
    },
  ];
}>();

// ズーム倍率の範囲/刻み。編集画面(`useGrapes.ts` の ZOOM_MIN/MAX/STEP)と値を揃える。
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.4;
const ZOOM_STEP = 0.1;
// フィット時にページ周囲へ残す余白(px)。編集画面(`useGrapes.ts` の FIT_MARGIN)に倣う。
const FIT_MARGIN = 32;

// 外側コンテナ(全高固定)。ブラウザズーム/リサイズ追随用に `ResizeObserver` で監視する。
const container = ref<HTMLElement>();
const viewport = ref<HTMLElement>();
const iframe = ref<HTMLIFrameElement>();
const useFallback = ref(false);
const rendering = ref(false);
// ページ送りの状態。`currentPage` は 1 起点, `pageCount` は総ページ数(0 = 未確定)。
// どちらも `nav` イベントの値をそのまま反映する。`renderAllPages: true`(下記 `render`)で全ページを
// 事前レイアウトするため `epage`(現在位置, 0 起点)・`epageCount`(総数)は整数の実測値になり,
// 自前カウンタを持たずに vivliostyle の実位置と常に一致させられる。
const currentPage = ref(1);
const pageCount = ref(0);
const atFirst = ref(true);
const atLast = ref(false);
// 表示倍率。既定はページ全体フィット(`applyFit` が自前計算して適用)。`userZoomed` が立つと
// 手動ズームへ切り替わり, 以後は resize でも自動フィットしない(編集画面と同挙動)。
const zoom = ref(1);
const userZoomed = ref(false);
// biome-ignore lint/suspicious/noExplicitAny: @vivliostyle/core の CoreViewer 型が動的import用途に不十分なため
let viewer: any = null;
// `navigateToPage` に渡す Navigation enum。動的 import 後にモジュールから束縛する。
// biome-ignore lint/suspicious/noExplicitAny: 同上(Navigation enum の動的束縛)
let nav: any = null;
let blobUrl: string | null = null;
let resizeObserver: ResizeObserver | null = null;

function emitState() {
  emit('state', {
    currentPage: currentPage.value,
    pageCount: pageCount.value,
    atFirst: atFirst.value,
    atLast: atLast.value,
    zoom: zoom.value,
    vivlioReady: !useFallback.value,
  });
}

function revoke() {
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
}

function disposeViewer() {
  try {
    viewer?.cleanup?.();
  } catch (e) {
    logError(toAppError(e));
  }
  viewer = null;
}

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

/**
 * ページ全体が収まるフィット倍率を自前計算して適用する(編集画面 `useGrapes.ts` の `fitToView`
 * と同方式: `min(availW/pageW, availH/pageH)` をクランプ)。
 *
 * Vivliostyle の `fitToScreen` は single-page では resize 時にフィットを再計算しない
 * (`sizeIsGood()` が spreadView 不変だと常に good を返し `resize()` が早期 return するため)。
 * よってブラウザズーム/リサイズ追随は本関数を `ResizeObserver` から呼んで実現する。
 */
function applyFit() {
  if (userZoomed.value || useFallback.value || !viewer || !container.value) return;
  const sizes = viewer.getPageSizes?.() as { width: number; height: number }[] | undefined;
  const ps = sizes?.[currentPage.value - 1] ?? sizes?.[0];
  if (!ps || !(ps.width > 0) || !(ps.height > 0)) return;
  const availW = container.value.clientWidth - FIT_MARGIN;
  const availH = container.value.clientHeight - FIT_MARGIN;
  if (availW <= 0 || availH <= 0) return;
  zoom.value = clampZoom(Math.min(availW / ps.width, availH / ps.height));
  viewer.setOptions({ zoom: zoom.value, fitToScreen: false });
  emitState();
}

async function render() {
  revoke();
  disposeViewer();
  currentPage.value = 1;
  pageCount.value = 0;
  atFirst.value = true;
  atLast.value = false;
  zoom.value = 1;
  userZoomed.value = false;
  if (!props.html) {
    rendering.value = false;
    emitState();
    return;
  }
  rendering.value = true;
  blobUrl = URL.createObjectURL(new Blob([props.html], { type: 'text/html' }));

  try {
    const mod = await import('@vivliostyle/core');
    const CoreViewer = mod.CoreViewer;
    nav = mod.Navigation;
    if (!viewport.value) {
      // viewport 不在(描画前にアンマウント等)。ローダーが残らないよう解除する。
      rendering.value = false;
      return;
    }
    viewport.value.innerHTML = '';
    // `renderAllPages: true` で全ページを事前レイアウトする。これにより Vivliostyle 内部の
    // `epageIsRenderedPage` が立ち, `nav` の `epageCount`(総数)・`epage`(現在位置)が圧縮バイト数
    // からの推定値ではなく実レイアウトの整数値になる(ページカウントのずれ対策)。表示は別オプション
    // `pageViewMode: SINGLE_PAGE` のまま 1 ページずつ。フィットは Vivliostyle の `fitToScreen` に
    // 任せず自前(`applyFit`)で行う(resize 時に再計算されない問題の回避)。
    viewer = new CoreViewer(
      { viewportElement: viewport.value },
      {
        autoResize: true,
        renderAllPages: true,
        pageViewMode: mod.PageViewMode.SINGLE_PAGE,
        fitToScreen: false,
      },
    );
    // `nav` イベントから総ページ数(`epageCount`)・現在位置(`epage`)・先頭/末尾フラグ(`first`/`last`)
    // を取る。`renderAllPages: true` 下では `epage` は実測の整数(0 起点)なので現在ページに使える。
    // 通知は 2 種あり, 初回カウント通知は `epageCount` のみ, 位置通知は `epage`+`epageCount` を持つ
    // ため, それぞれ独立に(値が来たときだけ)更新する。
    viewer.addListener(
      'nav',
      (p: { epage?: number; epageCount?: number; first?: boolean; last?: boolean }) => {
        if (typeof p.epageCount === 'number' && p.epageCount > 0) {
          pageCount.value = Math.max(1, Math.round(p.epageCount));
        }
        if (typeof p.epage === 'number') {
          // `epage` は 0 起点。1 起点表示へ +1 する。
          currentPage.value = Math.max(1, Math.round(p.epage) + 1);
        }
        if (typeof p.first === 'boolean') atFirst.value = p.first;
        if (typeof p.last === 'boolean') atLast.value = p.last;
        // 初回ロード/ページ確定後に自前フィットを適用(手動ズーム中は `applyFit` 内で無視)。
        applyFit();
        emitState();
      },
    );
    // 全ページのレイアウト確定(`readystatechange` -> `COMPLETE`)まで「生成中…」を出し続ける。
    // 事前レイアウトで初回描画に時間がかかるため, 確定前に空のビューポートを見せないようにする。
    viewer.addListener('readystatechange', () => {
      if (viewer?.readyState === mod.ReadyState.COMPLETE) rendering.value = false;
    });
    viewer.loadDocument({ url: blobUrl });
    useFallback.value = false;
  } catch (e) {
    // Fallback: `@vivliostyle/core` の読み込み/ページ分割が失敗したら素の iframe で表示する。
    // フォールバックでプレビュー自体は機能し続けるため, observability 目的のログのみに留める
    // (ユーザー向け toast は出さない)。
    logError(toAppError(e));
    useFallback.value = true;
    if (iframe.value) iframe.value.srcdoc = props.html;
    // iframe フォールバックは即時表示。レイアウト完了通知が来ないのでここで解除する。
    rendering.value = false;
  } finally {
    // 成功経路はローダーを解除しない。全ページ確定時の `readystatechange` -> `COMPLETE` で解除する。
    emitState();
  }
}

// 現在ページ(`currentPage`)/先頭・末尾フラグは更新せず, `navigateToPage` 後に発火する `nav`
// イベントで実位置から反映する(自前カウンタを持たず vivliostyle の実位置と常に一致させる)。
function prevPage() {
  if (!nav || atFirst.value || currentPage.value <= 1) return;
  viewer?.navigateToPage(nav.PREVIOUS);
}
function nextPage() {
  if (!nav || atLast.value || currentPage.value >= pageCount.value) return;
  viewer?.navigateToPage(nav.NEXT);
}
/**
 * 任意ページへ直接ジャンプする(1 起点)。`renderAllPages: true` で全ページが事前レイアウト
 * 済みのため `navigateToPage(EPAGE, 0 起点)` で実位置へ飛べる。`currentPage` 等は更新せず、
 * 続いて発火する `nav` イベントで実位置から反映する(自前カウンタを持たない方針を踏襲)。
 */
function goToPage(n: number) {
  if (!nav || useFallback.value || !viewer) return;
  const target = Math.min(Math.max(Math.round(n), 1), pageCount.value);
  viewer.navigateToPage(nav.EPAGE, target - 1);
}

function setManualZoom(z: number) {
  if (useFallback.value || !viewer) return;
  userZoomed.value = true;
  zoom.value = clampZoom(z);
  viewer.setOptions({ zoom: zoom.value, fitToScreen: false });
  emitState();
}
function zoomIn() {
  setManualZoom(zoom.value + ZOOM_STEP);
}
function zoomOut() {
  setManualZoom(zoom.value - ZOOM_STEP);
}
/** 画面に合わせる(自動フィットへ戻す)。 */
function fit() {
  if (useFallback.value || !viewer) return;
  userZoomed.value = false;
  applyFit();
}

watch(() => props.html, render, { immediate: true });

// ブラウザズーム(Chrome の Ctrl +/-)/ウィンドウ・ペインのリサイズ追随。Vivliostyle の
// `autoResize`(window `resize`)はブラウザズームで発火せず, かつ single-page では `sizeIsGood()`
// が常に good を返してフィットを再計算しない。そこで編集画面(`EditorView.vue` の canvas 監視)に
// 倣い, 全高固定の外側コンテナを `ResizeObserver` で監視し, 変化時に自前フィット(`applyFit`)を
// 再適用する。`applyFit` は手動ズーム中は無視し, コンテナ箱サイズは再フィットで変わらないため
// 自己再発火ループは起きない。`requestAnimationFrame` で多重発火をまとめる。
let resizePending = false;
onMounted(() => {
  if (!container.value) return;
  resizeObserver = new ResizeObserver(() => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      applyFit();
    });
  });
  resizeObserver.observe(container.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  revoke();
  disposeViewer();
});

defineExpose({ prevPage, nextPage, goToPage, zoomIn, zoomOut, fit });
</script>

<template>
  <div
    ref="container"
    class="relative h-full w-full overflow-hidden bg-[hsl(220_16%_91%)] dark:bg-[hsl(222_18%_18%)]"
  >
    <div
      v-if="rendering"
      class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/70 text-sm text-muted-foreground"
    >
      <Loader2 class="h-4 w-4 animate-spin" /> プレビューを生成中…
    </div>
    <div v-show="!useFallback" ref="viewport" class="h-full w-full"></div>
    <iframe
      v-show="useFallback"
      ref="iframe"
      class="h-full w-full border-0 bg-white"
      title="プレビュー"
    ></iframe>
  </div>
</template>

<style scoped>
/* Vivliostyle が screen 時に注入する viewport 背景(#aaaaaa)を, 編集画面キャンバス
   (`EditorView.vue` の `<main>`)と同じ薄グレーへ上書きして見た目を揃える。`ref="viewport"`
   要素自身に `data-vivliostyle-viewer-viewport` が付与されるため, scoped 化で付く `[data-v-...]`
   と合わさり, head へ後から注入される Vivliostyle 規則(同詳細度・後勝ち)より高詳細度で確実に勝つ
   (Tailwind ユーティリティクラスでは負ける)。screen 専用で PDF 出力には影響しない。 */
[data-vivliostyle-viewer-viewport] {
  background: hsl(220 16% 91%);
}
:global(.dark) [data-vivliostyle-viewer-viewport] {
  background: hsl(222 18% 18%);
}
</style>

<!-- 非 scoped: Vivliostyle が生成する子要素(`[data-vivliostyle-spread-container]` 配下)は
     Vue scoped の `[data-v-...]` を持たないため, ここは scoped にできない。 -->
<style>
/* 「真ん中のグレー」対策。アプリの Tailwind/shadcn base 規則 `*{border-color:var(--border)}`
   (薄灰 oklch)が, 本体 document に描画される Vivliostyle コンテンツへ漏れ, さらに Vivliostyle の
   `:where([style*=border]){border-width:medium}` ワークアラウンド(`border-collapse` 等の inline に
   反応)と相まって, 枠線を持たない要素(例 `.summary-table` テーブル自身)に薄灰 3px の枠が出る。
   編集画面は GrapesJS の iframe で base 規則が及ばず出ない。Vivliostyle コンテンツの既定 border-color
   を透明に戻し, テンプレが明示した枠線(Vivliostyle が inline 化=最優先で勝つ)だけを残す。
   screen 専用の見た目調整で, PDF 出力(別経路の `build.ts`)には影響しない。 */
[data-vivliostyle-spread-container] *,
[data-vivliostyle-spread-container] *::before,
[data-vivliostyle-spread-container] *::after {
  border-color: transparent;
}
</style>
