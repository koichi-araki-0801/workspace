import {
  isErr,
  isOk,
  ok,
  type PartCatalogItem,
  type PartHistoryEntry,
  type Template,
} from '@editor/shared';
import { computed, onBeforeUnmount, onMounted, reactive, ref, type ShallowRef, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { confirm } from '@/components/ui/confirm';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';
import { useAuthStore } from '@/stores/auth';
import { DEFAULT_GEOM, geomChangeLabel, geomFromStyle, geomToStyle, type LayoutGeom } from './geom';
import { useTemplateEditorService } from './services/templateEditorService';
import { useAutosave } from './useAutosave';
import { useGrapes } from './useGrapes';

/**
 * Editor screen orchestration: loads the template, drives the GrapesJS +
 * autosave lifecycle, resolves the canvas selection back to catalog docs, and
 * guards navigation while a save is pending/failed. Keeps {@link EditorView}
 * presentational. GrapesJS/Jinja internals stay in {@link useGrapes}/jinjaMask.
 */
export function useTemplateEditor(
  id: string,
  els: {
    canvasEl: Readonly<ShallowRef<HTMLElement | null>>;
    layersEl: Readonly<ShallowRef<HTMLElement | null>>;
  },
) {
  const { canvasEl, layersEl } = els;
  const service = useTemplateEditorService();
  const auth = useAuthStore();
  const g = useGrapes();

  const template = ref<Template | null>(null);
  const fundName = ref('');
  const partHistory = ref<PartHistoryEntry[]>([]);
  /** In-session edit-history entries per canvas component id (newest first). */
  const sessionHistory = reactive<Record<string, PartHistoryEntry[]>>({});
  let histSeq = 0;
  /** Last part clicked in the catalog (insert-time preview). */
  const previewPart = ref<PartCatalogItem | null>(null);
  /** Part resolved from the current canvas selection (null when not a catalog part). */
  const canvasPart = ref<PartCatalogItem | null>(null);
  /** Catalog parts cached for resolving a canvas selection back to its docs. */
  const partsById = new Map<string, PartCatalogItem>();

  /** Whether the left pane's "allow add/edit" mode is on. */
  const editMode = ref(false);

  // Properties pane: canvas selection when present, else the catalog preview.
  const selectedPart = computed(() => (g.selected.value ? canvasPart.value : previewPart.value));

  // Geometry of the current canvas selection (read from its inline style).
  // `g.revision` re-triggers this on every style/component change.
  const selectedGeom = computed(() => {
    void g.revision.value;
    return g.selected.value ? geomFromStyle(g.selectedStyle()) : null;
  });

  const autosave = useAutosave(async () => {
    if (!template.value) return ok(undefined);
    return service.saveDraft(id, g.getBodyHtml(), g.getCss());
  });

  // --- undo / redo (snapshot-based) ------------------------------------------
  // GrapesJS' UndoManager doesn't reliably track our programmatic style writes,
  // so we keep our own stacks of { html, css } snapshots and restore via load().
  type Snap = { html: string; css: string };
  const past: Snap[] = [];
  const future: Snap[] = [];
  const canUndo = ref(false);
  const canRedo = ref(false);
  let restoring = false;

  const snapshot = (): Snap => ({ html: g.getBodyHtml(), css: g.getCss() });
  const updateUndoFlags = () => {
    canUndo.value = past.length > 0;
    canRedo.value = future.length > 0;
  };
  /** Capture the pre-mutation state. Call right before a recordable change. */
  function pushUndo() {
    if (restoring) return;
    past.push(snapshot());
    if (past.length > 100) past.shift();
    future.length = 0;
    updateUndoFlags();
  }
  function restore(s: Snap) {
    restoring = true;
    g.load(s.html, s.css);
    // load() rebuilds components with default flags — reapply the lock state.
    g.setEditable(editMode.value);
    restoring = false;
    autosave.trigger();
    updateUndoFlags();
  }
  function undo() {
    if (!past.length) return;
    future.push(snapshot());
    restore(past.pop() as Snap);
  }
  function redo() {
    if (!future.length) return;
    past.push(snapshot());
    restore(future.shift() as Snap);
  }

  /** Record an edit-history entry against the current selection (in-session). */
  function recordChange(change: string) {
    const cid = g.selected.value?.id;
    if (!cid) return;
    const arr = sessionHistory[cid] ?? [];
    sessionHistory[cid] = arr;
    arr.unshift({
      id: `s${++histSeq}`,
      templateId: id,
      partId: cid,
      change,
      timestamp: new Date().toISOString(),
      user: auth.user?.displayName ?? '編集者',
    });
  }

  // Selected part's history = in-session edits first, then any persisted history.
  const displayHistory = computed<PartHistoryEntry[]>(() => {
    const cid = g.selected.value?.id;
    const sess = cid ? (sessionHistory[cid] ?? []) : [];
    return [...sess, ...partHistory.value];
  });

  /** Apply a geometry change to the selected block (written as inline style). */
  function applyGeom(patch: Partial<LayoutGeom>, record = true) {
    const cur = selectedGeom.value;
    if (!cur) return;
    if (record) pushUndo();
    const after = { ...cur, ...patch };
    g.patchSelectedStyle(geomToStyle(after));
    if (record) {
      const label = geomChangeLabel(cur, after);
      if (label) recordChange(label);
    }
  }

  /** Record a single history entry for a geometry diff (used after a handle drag). */
  function recordGeomDiff(before: LayoutGeom) {
    const after = selectedGeom.value;
    if (!after) return;
    const label = geomChangeLabel(before, after);
    if (label) recordChange(label);
  }

  /** Clear all layout styles on the selection (revert to default placement). */
  function resetGeom() {
    if (!g.selected.value) return;
    pushUndo();
    g.patchSelectedStyle(geomToStyle(DEFAULT_GEOM));
    recordChange('配置を初期化');
  }

  function onPartSelect(p: PartCatalogItem) {
    previewPart.value = p;
  }

  function onPartInsert(p: PartCatalogItem) {
    pushUndo();
    g.insertPart(p.content, p.id);
    // a freshly inserted part must honor the current lock state.
    g.setEditable(editMode.value);
    previewPart.value = p;
    recordChange(`パーツ「${p.name}」を追加`);
  }

  function moveSelected(dir: -1 | 1) {
    pushUndo();
    g.moveSelected(dir);
    recordChange(dir < 0 ? '順序を前へ移動' : '順序を後ろへ移動');
  }

  /** Delete the current selection (history-aware). */
  function deletePart() {
    if (!g.selected.value) return;
    pushUndo();
    g.deleteSelected();
  }

  // Lock/unlock the canvas when the left-pane checkbox toggles.
  watch(editMode, (on) => g.setEditable(on));

  watch(
    () => g.selected.value,
    async (sel) => {
      if (sel && !sel.isJinja) {
        const res = await service.getPartHistory(id, sel.id);
        partHistory.value = isOk(res) ? res.value : [];
      } else {
        partHistory.value = [];
      }
      canvasPart.value = sel?.partId ? (partsById.get(sel.partId) ?? null) : null;
    },
  );

  onMounted(async () => {
    const res = await service.loadForEdit(id);
    if (isErr(res)) {
      logError(res.error);
      toastError(res.error.message);
      return;
    }
    template.value = res.value.template;
    fundName.value = res.value.fundName;
    for (const p of res.value.parts) partsById.set(p.id, p);

    const canvas = canvasEl.value;
    const layers = layersEl.value;
    if (!canvas || !layers) return;
    g.init({ canvas, layers });
    g.load(res.value.editableBody, res.value.css);
    // start locked (editMode defaults to false).
    g.setEditable(editMode.value);
    g.onChange(() => autosave.trigger());
    // inline text edit: snapshot on start; on end, keep it only if content changed
    g.onTextEditStart(() => pushUndo());
    g.onTextEditEnd((changed) => {
      if (changed) {
        recordChange('テキストを編集');
      } else {
        past.pop();
        updateUndoFlags();
      }
    });
    // canvas drag-to-reorder: snapshot on start; record only when order changed
    g.onReorderStart(() => pushUndo());
    g.onReorderEnd((moved) => {
      if (moved) {
        recordChange('順序を変更');
      } else {
        past.pop();
        updateUndoFlags();
      }
    });

    // Keep the A4 sheet fitted to the pane width (until the user zooms manually).
    let fitRaf = 0;
    fitObserver = new ResizeObserver(() => {
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => g.fitToWidth(canvas.clientWidth));
    });
    fitObserver.observe(canvas);
    g.fitToWidth(canvas.clientWidth);
  });

  /** Observes the canvas pane so the A4 sheet re-fits on resize. */
  let fitObserver: ResizeObserver | null = null;

  // Warn before leaving (tab close / reload) while a save is in flight or failed.
  function beforeUnload(e: BeforeUnloadEvent) {
    if (autosave.state.value === 'saving' || autosave.state.value === 'error') {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  window.addEventListener('beforeunload', beforeUnload);

  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    fitObserver?.disconnect();
    g.destroy();
  });

  // In-app navigation guard: finish a pending save, and confirm if it failed.
  onBeforeRouteLeave(async () => {
    if (autosave.state.value === 'saving') await autosave.flush();
    if (autosave.state.value === 'error') {
      return confirm({
        title: '保存できていない変更があります',
        description: 'このまま移動すると、最後の変更が保存されない可能性があります。',
        confirmLabel: '移動する',
        cancelLabel: 'とどまる',
        variant: 'destructive',
      });
    }
    return true;
  });

  return {
    g,
    template,
    fundName,
    partHistory,
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
  };
}
