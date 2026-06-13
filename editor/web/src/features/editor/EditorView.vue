<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import { useRouter } from 'vue-router';
import EditorTopBar from './EditorTopBar.vue';
import { type LayoutGeom, PX_PER_MM } from './geom';
import Inspector from './Inspector.vue';
import PartToolbar from './PartToolbar.vue';
import PartTree from './PartTree.vue';
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
  editMode,
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

/** Position the floating toolbar just above the selected element's rect. */
const toolbarStyle = computed(() => {
  const r = g.selectedRect.value;
  if (!r) return { display: 'none' };
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    transform: 'translateY(-100%) translateY(-10px)',
  };
});

// --- zoom-independent drag handles (width / top-margin / bottom-margin) -------
// 'width'/'width-left' resize the block width (left side inverts the delta so the
// handle follows the cursor); 'mt'/'mb' adjust the top/bottom margins.
type HandleKind = 'width' | 'width-left' | 'mt' | 'mb';
const activeHandle = ref<HandleKind | null>(null);
let drag: { kind: HandleKind; x: number; y: number; geom: LayoutGeom; fullW: number } | null = null;

function startHandle(kind: HandleKind, e: MouseEvent) {
  const g0 = selectedGeom.value;
  const r = g.selectedRect.value;
  if (!g0 || !r) return;
  e.preventDefault();
  e.stopPropagation();
  pushUndo(); // one undo step per drag
  activeHandle.value = kind;
  drag = { kind, x: e.clientX, y: e.clientY, geom: { ...g0 }, fullW: r.width / (Math.max(g0.widthPct, 1) / 100) };
  window.addEventListener('mousemove', onHandleMove);
  window.addEventListener('mouseup', onHandleUp);
}
function onHandleMove(e: MouseEvent) {
  if (!drag) return;
  const z = g.zoom.value;
  if (drag.kind === 'width' || drag.kind === 'width-left') {
    const sign = drag.kind === 'width-left' ? -1 : 1;
    const dPct = ((e.clientX - drag.x) / drag.fullW) * 100 * sign;
    const w = Math.round(Math.min(100, Math.max(20, drag.geom.widthPct + dPct)));
    // live apply without recording (history is recorded once on mouseup)
    applyGeom({ widthPct: w, align: w >= 100 ? 'stretch' : drag.geom.align === 'stretch' ? 'left' : drag.geom.align }, false);
  } else {
    const dmm = Math.round((e.clientY - drag.y) / z / PX_PER_MM);
    const key = drag.kind === 'mt' ? 'marginTop' : 'marginBottom';
    applyGeom({ [key]: Math.min(60, Math.max(0, drag.geom[key] + dmm)) } as Partial<LayoutGeom>, false);
  }
}
function onHandleUp() {
  if (drag) recordGeomDiff(drag.geom);
  drag = null;
  activeHandle.value = null;
  window.removeEventListener('mousemove', onHandleMove);
  window.removeEventListener('mouseup', onHandleUp);
}

const rect = computed(() => g.selectedRect.value);

/** Live value bubble shown next to the handle being dragged. */
const dragLabel = computed(() => {
  const k = activeHandle.value;
  const r = rect.value;
  const gm = selectedGeom.value;
  if (!k || !r || !gm) return null;
  if (k === 'mt') return { left: r.left + r.width / 2, top: r.top, text: `上 ${gm.marginTop}mm` };
  if (k === 'mb') return { left: r.left + r.width / 2, top: r.top + r.height, text: `下 ${gm.marginBottom}mm` };
  const left = k === 'width-left' ? r.left : r.left + r.width;
  return { left, top: r.top + r.height / 2, text: `${gm.widthPct}%` };
});

async function goPreview() {
  await autosave.flush();
  router.push({ name: 'preview', params: { id: props.id } });
}

function zoomIn() {
  g.autoFit.value = false; // user took manual control of zoom
  g.setZoom(g.zoom.value + 0.1);
}
function zoomOut() {
  g.autoFit.value = false;
  g.setZoom(g.zoom.value - 0.1);
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
      <PartTree v-model:edit-mode="editMode" @select="onPartSelect" @insert="onPartInsert" />

      <!-- center: GrapesJS canvas, styled as A4 paper -->
      <main class="relative flex-1 overflow-hidden bg-[hsl(220_16%_91%)] dark:bg-[hsl(222_18%_18%)]">
        <div ref="canvasEl" class="h-full"></div>
        <!-- GrapesJS layer manager is mounted but visually hidden (prototype has no layers panel) -->
        <div ref="layersEl" class="hidden"></div>

        <!-- floating layout toolbar + drag handles over the selected block -->
        <div class="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <!-- edit affordances (handles + toolbar) only when unlocked -->
          <template v-if="rect && selectedGeom && editMode">
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

            <!-- toolbar -->
            <div class="pointer-events-auto absolute" :style="toolbarStyle">
              <PartToolbar
                :geom="selectedGeom"
                :edit-mode="editMode"
                :can-up="g.canMoveUp.value"
                :can-down="g.canMoveDown.value"
                @apply="applyGeom"
                @move="moveSelected($event)"
                @movestart="g.startMove($event)"
                @reset="resetGeom"
                @del="deletePart"
              />
            </div>
          </template>
        </div>
      </main>

      <!-- right: properties + history -->
      <Inspector
        :selected="g.selected.value"
        :part="selectedPart"
        :geom="selectedGeom"
        :history="displayHistory"
      />
    </div>
  </div>
</template>

<style scoped>
/* faint frame echoing the selection so the resize box is obvious */
.ret-frame {
  position: absolute;
  pointer-events: none;
  border: 1.5px dashed hsl(var(--primary) / 0.55);
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
  background: hsl(var(--primary));
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
  background: hsl(var(--primary) / 0.85);
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
  border: 2px solid hsl(var(--primary));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

/* live value bubble shown while dragging a handle */
.ret-drag-label {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 3px 8px;
  border-radius: 6px;
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  z-index: 30;
}
</style>

