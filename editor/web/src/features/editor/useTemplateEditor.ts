import {
  isErr,
  isOk,
  ok,
  type PartCatalogItem,
  type PartHistoryEntry,
  type Template,
} from '@editor/shared';
import { computed, onBeforeUnmount, onMounted, ref, type ShallowRef, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { confirm } from '@/components/ui/confirm';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';
import { useAuthStore } from '@/stores/auth';
import { DEFAULT_GEOM, geomChangeLabel, geomFromStyle, geomToStyle, type LayoutGeom } from './geom';
import { useTemplateEditorService } from './services/templateEditorService';
import { useAutosave } from './useAutosave';
import { useGrapes } from './useGrapes';
import { usePartEditHistory } from './usePartEditHistory';
import { useSnapshotHistory } from './useSnapshotHistory';

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
  /** Last part clicked in the catalog (insert-time preview). */
  const previewPart = ref<PartCatalogItem | null>(null);
  /** Part resolved from the current canvas selection (null when not a catalog part). */
  const canvasPart = ref<PartCatalogItem | null>(null);
  /** Catalog parts cached for resolving a canvas selection back to its docs. */
  const partsById = new Map<string, PartCatalogItem>();

  /** Left-pane "パーツを追加" toggle: shows the catalog and allows inserts. */
  const allowAdd = ref(false);
  /** Left-pane "編集を許可" toggle: makes the canvas editable (text/reorder/layout). */
  const allowEdit = ref(false);

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
  const { canUndo, canRedo, pushUndo, undo, redo, discardLast } = useSnapshotHistory(
    () => ({ html: g.getBodyHtml(), css: g.getCss() }),
    (s) => {
      g.load(s.html, s.css);
      // load() rebuilds components with default flags — reapply the lock state.
      g.setEditable(allowEdit.value);
      autosave.trigger();
    },
  );

  const { record: recordChange, displayHistory } = usePartEditHistory(
    id,
    () => g.selected.value?.id,
    () => auth.user?.displayName ?? '編集者',
    () => partHistory.value,
  );

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
    g.setEditable(allowEdit.value);
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

  // Lock/unlock the canvas when the "編集を許可" checkbox toggles.
  watch(allowEdit, (on) => g.setEditable(on));

  // Bumped on every selection change; the async history fetch below discards its
  // result if a newer selection superseded it (prevents a slow response from
  // overwriting a different part's history).
  let historySeq = 0;
  watch(
    () => g.selected.value,
    async (sel) => {
      const seq = ++historySeq;
      // Resolve the catalog part synchronously so the properties pane updates
      // immediately, without waiting on the history fetch.
      canvasPart.value = sel?.partId ? (partsById.get(sel.partId) ?? null) : null;
      if (sel && !sel.isJinja) {
        const res = await service.getPartHistory(id, sel.id);
        if (seq !== historySeq) return; // a newer selection won the race
        partHistory.value = isOk(res) ? res.value : [];
      } else {
        partHistory.value = [];
      }
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
    // start locked (allowEdit defaults to false).
    g.setEditable(allowEdit.value);
    g.onChange(() => autosave.trigger());
    // inline text edit: snapshot on start; on end, keep it only if content changed
    g.onTextEditStart(() => pushUndo());
    g.onTextEditEnd((changed) => {
      if (changed) {
        recordChange('テキストを編集');
      } else {
        discardLast();
      }
    });
    // canvas drag-to-reorder: snapshot on start; record only when order changed
    g.onReorderStart(() => pushUndo());
    g.onReorderEnd((moved) => {
      if (moved) {
        recordChange('順序を変更');
      } else {
        discardLast();
      }
    });
  });

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
  };
}
