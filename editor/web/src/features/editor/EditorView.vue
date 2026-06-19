<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from 'vue';
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

// Zoom-independent block resize / margin drag handles (see useGeomHandles).
const { startHandle, dragLabel } = useGeomHandles({
  selectedGeom,
  selectedRect: g.selectedRect,
  zoom: g.zoom,
  pushUndo,
  applyGeom,
  recordGeomDiff,
});

const rect = computed(() => g.selectedRect.value);

async function goPreview() {
  await autosave.flush();
  router.push({ name: 'preview', params: { id: props.id } });
}

// Keep the selection overlay (frame/handles/toolbar) aligned when the canvas
// container changes size. `g.selectedRect` is otherwise only recomputed on
// canvas scroll/content events, so a window (or pane) resize would shift the
// centered A4 iframe while the overlay stays put. The `requestAnimationFrame`
// defers the measure until after GrapesJS re-lays out (mirrors `setZoom`).
let canvasResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const el = canvasEl.value;
  if (!el) return;
  canvasResizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => g.refreshRect());
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

/** Autosave status line; includes the last-saved time when known. */
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
      @undo="undo"
      @redo="redo"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @save="autosave.flush()"
      @preview="goPreview"
    />

    <div class="flex flex-1 overflow-hidden">
      <!-- left: part add (checkbox → cascading filter) -->
      <PartTree
        v-model:allow-add="allowAdd"
        v-model:allow-edit="allowEdit"
        @select="onPartSelect"
        @insert="onPartInsert"
      />

      <!-- center: GrapesJS canvas, styled as A4 paper -->
      <main class="relative flex-1 overflow-hidden bg-[hsl(220_16%_91%)] dark:bg-[hsl(222_18%_18%)]">
        <div ref="canvasEl" class="h-full"></div>
        <!-- GrapesJS layer manager is mounted but visually hidden (prototype has no layers panel) -->
        <div ref="layersEl" class="hidden"></div>

        <!-- width/margin drag handles over the selected block (layout edits also
             live in the right-pane `Inspector.vue`; no floating toolbar here) -->
        <div class="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <!-- edit affordances (drag handles) only when editing is allowed -->
          <template v-if="rect && selectedGeom && allowEdit">
            <!-- selection frame echo so the resize box reads clearly -->
            <div
              class="ret-frame"
              :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
            />

            <!-- edge handles: left/right = width, top/bottom = margins -->
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

            <!-- corner handles (drive width via horizontal delta) -->
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

            <!-- live value bubble while dragging a handle -->
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

      <!-- right: editable properties (collapsible) + history -->
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

