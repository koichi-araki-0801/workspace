import {
  isErr,
  isOk,
  ok,
  type PartCatalogItem,
  type PartHistoryEntry,
  type Template,
} from '@editor/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { confirm } from '@/components/ui/confirm';
import { toastError } from '@/components/ui/toast';
import { logError } from '@/lib/appError';
import { useTemplateEditorService } from './services/templateEditorService';
import { useAutosave } from './useAutosave';
import { useGrapes } from './useGrapes';

/**
 * Editor screen orchestration: loads the template, drives the GrapesJS +
 * autosave lifecycle, resolves the canvas selection back to catalog docs, and
 * guards navigation while a save is pending/failed. Keeps {@link EditorView}
 * presentational. GrapesJS/Jinja internals stay in {@link useGrapes}/jinjaMask.
 */
export function useTemplateEditor(id: string) {
  const service = useTemplateEditorService();
  const g = useGrapes();

  const template = ref<Template | null>(null);
  const partHistory = ref<PartHistoryEntry[]>([]);
  /** Last part clicked in the catalog (insert-time preview). */
  const previewPart = ref<PartCatalogItem | null>(null);
  /** Part resolved from the current canvas selection (null when not a catalog part). */
  const canvasPart = ref<PartCatalogItem | null>(null);
  /** Catalog parts cached for resolving a canvas selection back to its docs. */
  const partsById = new Map<string, PartCatalogItem>();

  const canvasEl = ref<HTMLElement>();
  const layersEl = ref<HTMLElement>();

  // Properties pane: canvas selection when present, else the catalog preview.
  const selectedPart = computed(() => (g.selected.value ? canvasPart.value : previewPart.value));

  const autosave = useAutosave(async () => {
    if (!template.value) return ok(undefined);
    return service.saveDraft(id, g.getBodyHtml(), g.getCss());
  });

  function onPartSelect(p: PartCatalogItem) {
    previewPart.value = p;
  }

  function onPartInsert(p: PartCatalogItem) {
    g.insertPart(p.content, p.id);
    previewPart.value = p;
  }

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
    for (const p of res.value.parts) partsById.set(p.id, p);

    const canvas = canvasEl.value;
    const layers = layersEl.value;
    if (!canvas || !layers) return;
    g.init({ canvas, layers });
    g.load(res.value.editableBody, res.value.css);
    g.onChange(() => autosave.trigger());
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
    partHistory,
    selectedPart,
    autosave,
    canvasEl,
    layersEl,
    onPartSelect,
    onPartInsert,
  };
}
