<script setup lang="ts">
// =============================================================================
// PageRail.vue — スクロールバー状の縦ページ目盛り(スクラバ)
// =============================================================================
// 400 ページ規模でも一目で現在位置を掴み、任意ページへドラッグ/クリックで飛べる縦レール。
// 肝は「ページ数に比例して DOM を増やさない」点 — 目盛りラベルは間引いて最大十数個、つまみは
// 1 個だけにする。親が relative なコンテナの右端へ絶対配置する想定。移動ロジックは親に委ね、
// 確定ページを `go`(1 起点)で通知する(presentational)。複数ページ時のみ親が出す。
import { computed, ref } from 'vue';
import { fractionToPage, pageToFraction } from './pageNav';

const props = withDefaults(
  defineProps<{
    /** 1 起点の現在ページ番号(目盛りハイライト用)。 */
    currentPage: number;
    pageCount: number;
    /**
     * 全ページ連続表示時のビューポート縦位置(0..1)。これがあるとつまみは実スクロール位置を
     * 映す。1 ページ表示や vivliostyle の離散表示では `null`(= ページ中央に置く)。
     */
    scrollFraction?: number | null;
  }>(),
  { scrollFraction: null },
);

const emit = defineEmits<{ go: [page: number] }>();

const railEl = ref<HTMLElement | null>(null);
const dragging = ref(false);
const hoverPage = ref<number | null>(null);
const hoverFrac = ref(0); // ホバー/ドラッグ中ツールチップの縦位置(0..1)

// つまみ位置: 連続表示中は実スクロール比率を優先(見えている位置)、それ以外はページ区間中央。
const thumbTop = computed(() => {
  const f =
    props.scrollFraction != null
      ? Math.min(Math.max(props.scrollFraction, 0), 1)
      : pageToFraction(props.currentPage, props.pageCount);
  return `${f * 100}%`;
});

// 目盛りラベル: ページ数に比例させず最大十数個へ間引く(端と現在ページは常に含める)。
const ticks = computed(() => {
  const count = props.pageCount;
  if (count <= 1) return [] as { page: number; top: string }[];
  const stride = Math.max(1, Math.ceil(count / 12));
  const pages = new Set<number>([1, count, props.currentPage]);
  for (let p = 1; p <= count; p += stride) pages.add(p);
  return [...pages]
    .sort((a, b) => a - b)
    .map((page) => ({ page, top: `${pageToFraction(page, count) * 100}%` }));
});

/** ポインタ位置から縦位置比率とジャンプ先ページ(1 起点)を求める。 */
function locate(e: PointerEvent): { page: number; frac: number } {
  const el = railEl.value;
  if (!el) return { page: props.currentPage, frac: 0 };
  const r = el.getBoundingClientRect();
  const frac = r.height > 0 ? Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) : 0;
  return { page: fractionToPage(frac, props.pageCount), frac };
}
function onPointerDown(e: PointerEvent): void {
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  emit('go', locate(e).page);
}
function onPointerMove(e: PointerEvent): void {
  const { page, frac } = locate(e);
  hoverPage.value = page;
  hoverFrac.value = frac;
  if (dragging.value) emit('go', page);
}
function onPointerUp(e: PointerEvent): void {
  dragging.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
}
function onLeave(): void {
  if (!dragging.value) hoverPage.value = null;
}
/** 上下キー/Home/End でのキーボード操作(端は clamp)。 */
function key(target: number): void {
  emit('go', Math.min(Math.max(target, 1), props.pageCount));
}
</script>

<template>
  <!-- ページ送りのアクセシブルな正規操作は上部バーの `PageNav`(番号入力・スクリーンリーダー
       対応)。本レールはポインタ主体の補助 affordance なので `role=slider` は付けず、キーボード
       focus と上下/Home/End だけ補助的に受ける(`aria-label` で用途を示す)。 -->
  <div
    ref="railEl"
    class="page-rail"
    aria-label="ページスクロール"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onLeave"
    @keydown.up.prevent="key(currentPage - 1)"
    @keydown.down.prevent="key(currentPage + 1)"
    @keydown.home.prevent="key(1)"
    @keydown.end.prevent="key(pageCount)"
  >
    <div class="page-rail-track" />
    <!-- 間引いた目盛りラベル(最大十数個)。クリックはレール本体が拾う。 -->
    <span
      v-for="t in ticks"
      :key="t.page"
      class="page-rail-tick"
      :class="{ 'is-current': t.page === currentPage }"
      :style="{ top: t.top }"
      >{{ t.page }}</span
    >
    <!-- 現在位置つまみ(1 個のみ) -->
    <div class="page-rail-thumb" :style="{ top: thumbTop }" />
    <!-- ホバー/ドラッグ中のジャンプ先ページ番号 -->
    <div v-if="hoverPage != null" class="page-rail-tip" :style="{ top: `${hoverFrac * 100}%` }">
      {{ hoverPage }}
    </div>
  </div>
</template>

<style scoped>
/* 右端に立てる縦レール。canvas の灰色余白の上に重なる。クリック/ドラッグを拾うため
   pointer-events は既定(auto)のまま。z-index は EditorView の overlay 層(guide=10 /
   frame=22 / handle=25)とぶつからない 23 に置く(プレビューでは単独なので影響なし)。 */
.page-rail {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 34px;
  z-index: 23;
  cursor: pointer;
  user-select: none;
  touch-action: none;
}
.page-rail:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
/* 中央の細い溝(トラック)。 */
.page-rail-track {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 2px;
  background: color-mix(in oklab, var(--muted-foreground) 35%, transparent);
}
/* 間引いたページ番号ラベル。トラック左側に小さく置く。 */
.page-rail-tick {
  position: absolute;
  right: 14px;
  transform: translateY(-50%);
  font-size: 9px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
  pointer-events: none;
  white-space: nowrap;
}
.page-rail-tick.is-current {
  color: var(--primary);
  font-weight: 700;
}
/* 現在位置のつまみ。 */
.page-rail-thumb {
  position: absolute;
  left: 50%;
  width: 11px;
  height: 11px;
  transform: translate(-50%, -50%);
  border-radius: 9999px;
  background: var(--primary);
  box-shadow: 0 0 0 2px var(--background);
  pointer-events: none;
}
/* ホバー/ドラッグ中に出るジャンプ先ページ番号の吹き出し。 */
.page-rail-tip {
  position: absolute;
  right: 100%;
  transform: translateY(-50%);
  margin-right: 4px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--primary-foreground);
  background: var(--primary);
  pointer-events: none;
}
</style>
