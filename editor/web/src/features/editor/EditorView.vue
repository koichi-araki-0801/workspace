<script setup lang="ts">
// =============================================================================
// EditorView.vue — editor 画面のレイアウト(上部バー / 左ペイン / canvas / 右ペイン)
// =============================================================================
// 役割: `useTemplateEditor.ts` / `useGeomHandles.ts` を束ね、canvas 上に選択 overlay
// (ページ境界 guide / ドラッグハンドル / move grip)を描く presentational なルート。
import { GripVertical } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import { useRouter } from 'vue-router';
import EditorTopBar from './EditorTopBar.vue';
import Inspector from './Inspector.vue';
import PartTree from './PartTree.vue';
import { useGeomHandles } from './useGeomHandles';
import { ZOOM_STEP } from './useGrapes';
import { useTemplateEditor } from './useTemplateEditor';

const props = defineProps<{ id: string }>();
const router = useRouter();

const canvasEl = useTemplateRef<HTMLElement>('canvasEl');
const layersEl = useTemplateRef<HTMLElement>('layersEl');

const {
  g,
  template,
  fundName,
  displayHistory,
  selectedPart,
  selectedGeom,
  allowAdd,
  allowEdit,
  autosave,
  canUndo,
  canRedo,
  undo,
  redo,
  pushUndo,
  applyGeom,
  recordGeomDiff,
  resetGeom,
  moveSelected,
  deletePart,
  onPartSelect,
  onPartInsert,
} = useTemplateEditor(props.id, { canvasEl, layersEl });

// zoom 非依存のブロック resize / 余白ドラッグハンドル(`useGeomHandles.ts` を見よ)。
const { startHandle, dragLabel } = useGeomHandles({
  selectedGeom,
  selectedRect: g.selectedRect,
  zoom: g.zoom,
  pushUndo,
  applyGeom,
  recordGeomDiff,
});

const rect = computed(() => g.selectedRect.value);

// ページ境界の overlay guide: 既定 ON、上部バーから切替える。
const showPageGuides = ref(true);

async function goPreview() {
  await autosave.flush();
  router.push({ name: 'preview', params: { id: props.id } });
}

// canvas コンテナのサイズ変化時も選択 overlay(frame/handle/toolbar)の位置を保つ。
// `g.selectedRect` は本来 canvas の scroll/content イベントでしか再計算されないため、
// window(やペイン)の resize ではセンタリングされた A4 iframe が動く一方 overlay が
// 取り残される。`requestAnimationFrame` で GrapesJS の再レイアウト後まで計測を遅らせる
// (`setZoom` と同じ手法)。
let canvasResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const el = canvasEl.value;
  if (!el) return;
  canvasResizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      g.refreshRect();
      g.refreshPageGuides();
    });
  });
  canvasResizeObserver.observe(el);
});
onBeforeUnmount(() => {
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
});

function zoomIn() {
  g.setZoom(g.zoom.value + ZOOM_STEP);
}
function zoomOut() {
  g.setZoom(g.zoom.value - ZOOM_STEP);
}

/** autosave のステータス行。判明していれば最終保存時刻も含める。 */
const statusText = computed(() => {
  const at = autosave.lastSavedAt.value;
  const savedAt = at
    ? `${at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に自動保存`
    : null;
  switch (autosave.state.value) {
    case 'saving':
      return '保存中…';
    case 'error':
      return '保存に失敗しました';
    case 'saved':
      return savedAt ?? '保存しました';
    default:
      return savedAt ?? '自動保存';
  }
});
</script>

<template>
  <div class="flex h-screen flex-col bg-background">
    <EditorTopBar
      :fund-name="fundName"
      :attributes="template?.meta.attributes"
      :save-state="autosave.state.value"
      :status-text="statusText"
      :zoom="g.zoom.value"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :show-page-guides="showPageGuides"
      @undo="undo"
      @redo="redo"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @toggle-page-guides="showPageGuides = !showPageGuides"
      @save="autosave.flush()"
      @preview="goPreview"
    />

    <div class="flex flex-1 overflow-hidden">
      <!-- 左: パーツ追加(チェックボックス → cascading な絞り込み) -->
      <PartTree
        v-model:allow-add="allowAdd"
        v-model:allow-edit="allowEdit"
        @select="onPartSelect"
        @insert="onPartInsert"
      />

      <!-- 中央: A4 用紙の見た目にした GrapesJS canvas -->
      <main class="relative flex-1 overflow-hidden bg-[hsl(220_16%_91%)] dark:bg-[hsl(222_18%_18%)]">
        <div ref="canvasEl" class="h-full"></div>
        <!-- GrapesJS の layer manager はマウントするが視覚的に隠す(prototype に layers パネルは無い) -->
        <div ref="layersEl" class="hidden"></div>

        <!-- 選択ブロック上の幅/余白ドラッグハンドル(layout 編集は右ペインの
             `Inspector.vue` にもある。ここに浮動ツールバーは置かない) -->
        <div class="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <!-- ページ境界 guide: 実際の page break(実線)+ 297mm の estimate(破線) -->
          <template v-if="showPageGuides">
            <div
              v-for="gd in g.pageGuides.value"
              :key="`${gd.kind}-${gd.page}`"
              class="pg-line"
              :class="`pg-${gd.kind}`"
              :style="{ left: `${gd.left}px`, top: `${gd.top}px`, width: `${gd.width}px` }"
            >
              <span class="pg-label">ここまで {{ gd.page }}ページ目<template v-if="gd.kind === 'estimate'">（目安）</template></span>
            </div>
          </template>

          <!-- 編集の affordance(ドラッグハンドル)は編集許可時のみ -->
          <template v-if="rect && selectedGeom && allowEdit">
            <!-- drag grip: 選択ブロックを兄弟内で並べ替える -->
            <div
              v-if="g.canDragSelected.value"
              class="pg-move pointer-events-auto"
              title="ドラッグで順序を移動"
              :style="{ left: `${rect.left}px`, top: `${rect.top}px` }"
              @mousedown="g.startMove($event)"
            >
              <GripVertical class="h-4 w-4" />
            </div>

            <!-- resize box を分かりやすくするための選択フレームの写し -->
            <div
              class="ret-frame"
              :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
            />

            <!-- edge ハンドル: 左右 = 幅、上下 = 余白 -->
            <div
              class="ret-handle ret-handle-x pointer-events-auto"
              title="幅をドラッグ"
              :style="{ left: `${rect.left + rect.width}px`, top: `${rect.top + rect.height / 2}px`, cursor: 'ew-resize' }"
              @mousedown="startHandle('width', $event)"
            />
            <div
              class="ret-handle ret-handle-x pointer-events-auto"
              title="幅をドラッグ"
              :style="{ left: `${rect.left}px`, top: `${rect.top + rect.height / 2}px`, cursor: 'ew-resize' }"
              @mousedown="startHandle('width-left', $event)"
            />
            <div
              class="ret-handle ret-handle-y pointer-events-auto"
              title="上の余白をドラッグ"
              :style="{ left: `${rect.left + rect.width / 2}px`, top: `${rect.top}px`, cursor: 'ns-resize' }"
              @mousedown="startHandle('mt', $event)"
            />
            <div
              class="ret-handle ret-handle-y pointer-events-auto"
              title="下の余白をドラッグ"
              :style="{ left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height}px`, cursor: 'ns-resize' }"
              @mousedown="startHandle('mb', $event)"
            />

            <!-- corner ハンドル(水平方向の delta で幅を駆動する) -->
            <div
              class="ret-corner pointer-events-auto"
              :style="{ left: `${rect.left}px`, top: `${rect.top}px`, cursor: 'nwse-resize' }"
              @mousedown="startHandle('width-left', $event)"
            />
            <div
              class="ret-corner pointer-events-auto"
              :style="{ left: `${rect.left + rect.width}px`, top: `${rect.top}px`, cursor: 'nesw-resize' }"
              @mousedown="startHandle('width', $event)"
            />
            <div
              class="ret-corner pointer-events-auto"
              :style="{ left: `${rect.left}px`, top: `${rect.top + rect.height}px`, cursor: 'nesw-resize' }"
              @mousedown="startHandle('width-left', $event)"
            />
            <div
              class="ret-corner pointer-events-auto"
              :style="{ left: `${rect.left + rect.width}px`, top: `${rect.top + rect.height}px`, cursor: 'nwse-resize' }"
              @mousedown="startHandle('width', $event)"
            />

            <!-- ハンドルのドラッグ中に出すライブ値の bubble -->
            <div
              v-if="dragLabel"
              class="ret-drag-label"
              :style="{ left: `${dragLabel.left}px`, top: `${dragLabel.top}px` }"
            >
              {{ dragLabel.text }}
            </div>

          </template>
        </div>
      </main>

      <!-- 右: 編集可能なプロパティ(折りたたみ式)+ 履歴 -->
      <Inspector
        :selected="g.selected.value"
        :part="selectedPart"
        :geom="selectedGeom"
        :history="displayHistory"
        :edit-mode="allowEdit"
        :can-up="g.canMoveUp.value"
        :can-down="g.canMoveDown.value"
        @apply="applyGeom"
        @move="moveSelected($event)"
        @reset="resetGeom"
        @del="deletePart"
      />
    </div>
  </div>
</template>

<style scoped>
/* page-boundary guides drawn over the A4 sheet (sit below the selection frame) */
.pg-line {
  position: absolute;
  height: 0;
  pointer-events: none;
  z-index: 10;
}
/* real page break (from .page / break-* / page-break-*): confident solid line */
.pg-break {
  border-top: 1px solid color-mix(in oklab, var(--primary) 60%, transparent);
}
/* 297mm estimate fallback (no explicit breaks): faint dashed line */
.pg-estimate {
  border-top: 1px dashed color-mix(in oklab, var(--muted-foreground) 60%, transparent);
}
.pg-label {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 1px 6px;
  border-radius: 6px 6px 0 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--primary-foreground);
  background: color-mix(in oklab, var(--primary) 78%, transparent);
}
.pg-estimate .pg-label {
  color: var(--muted-foreground);
  background: color-mix(in oklab, var(--muted) 92%, transparent);
}

/* drag grip on the selected block — large, obvious grab target for reorder */
.pg-move {
  position: absolute;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -110%);
  border-radius: 6px;
  color: var(--primary-foreground);
  background: var(--primary);
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
  cursor: grab;
  z-index: 26;
  user-select: none;
}
.pg-move:active {
  cursor: grabbing;
}

/* faint frame echoing the selection so the resize box is obvious */
.ret-frame {
  position: absolute;
  pointer-events: none;
  border: 1.5px dashed color-mix(in oklab, var(--primary) 55%, transparent);
  border-radius: 3px;
  z-index: 22;
}

/* edge handles: elongated bars with a generous transparent hit area.
   The visible knob is centered via the ::before pseudo-element. */
.ret-handle {
  position: absolute;
  transform: translate(-50%, -50%);
  z-index: 25;
  user-select: none;
}
.ret-handle::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 6px;
  background: var(--primary);
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}
/* width handles: tall vertical bar */
.ret-handle-x {
  width: 28px;
  height: 44px;
}
.ret-handle-x::before {
  width: 8px;
  height: 30px;
}
/* margin handles: wide horizontal bar */
.ret-handle-y {
  width: 44px;
  height: 28px;
}
.ret-handle-y::before {
  width: 30px;
  height: 8px;
}
.ret-handle:hover::before {
  background: color-mix(in oklab, var(--primary) 85%, transparent);
}

/* corner handles: square knob with a comfortable hit target */
.ret-corner {
  position: absolute;
  width: 26px;
  height: 26px;
  transform: translate(-50%, -50%);
  z-index: 25;
  user-select: none;
}
.ret-corner::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 11px;
  height: 11px;
  transform: translate(-50%, -50%);
  border-radius: 3px;
  background: #fff;
  border: 2px solid var(--primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

/* live value bubble shown while dragging a handle */
.ret-drag-label {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  z-index: 30;
}
</style>

