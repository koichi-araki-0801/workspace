import { toAppError } from '@editor/shared';
import grapesjs, { type Component, type Editor } from 'grapesjs';
import { ref, shallowRef } from 'vue';
import { logError } from '@/lib/appError';
import 'grapesjs/dist/css/grapes.min.css';
import { pageContentPx } from './geom';
import { type GrapesCallbacks, type SelectedRect, wireGrapesEvents } from './grapesEvents';
import { jinjaChipCanvasCss, registerJinjaComponents } from './jinjaComponents';

/**
 * A single page-boundary guide drawn over the A4 sheet (canvas-relative,
 * zoom-aware coords, like {@link SelectedRect}). `kind: 'break'` marks a real
 * page break (`break-*`/`page-break-*`, incl. class-driven `.page`) — the end of
 * a logical page block; `'estimate'` marks where a single block overruns one
 * printable page and print will split it further (dashed 297mm-ish sub-guide).
 * Both are numbered by cumulative physical page (see {@link refreshPageGuides}).
 */
export interface PageGuide {
  top: number;
  left: number;
  width: number;
  /** Cumulative physical page number that *ends* at this boundary (「ここまで N ページ目」). */
  page: number;
  kind: 'break' | 'estimate';
}

export interface GrapesContainers {
  canvas: HTMLElement;
  layers: HTMLElement;
}

// Canvas zoom bounds and the per-click step. Shared with {@link EditorView}'s
// zoom in/out buttons so they clamp to the same range as {@link setZoom}.
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 1.4;
export const ZOOM_STEP = 0.1;

/**
 * Make the GrapesJS canvas body look like an A4 sheet of paper. The iframe
 * itself is constrained to A4 width via `.gjs-frame*` rules in index.css, so the
 * body here only needs the page padding/shadow (no auto-centering margin).
 */
const a4CanvasCss = `
  html { background: transparent; }
  body {
    background: #fff;
    width: 210mm;
    min-height: 297mm;
    margin: 0;
    padding: 18mm 16mm;
    box-sizing: border-box;
    box-shadow: 0 1px 3px rgba(20,28,48,.10), 0 16px 44px -18px rgba(20,28,48,.32);
    font-family: 'Hiragino Mincho ProN','Yu Mincho','Noto Serif JP Variable','Noto Serif JP',serif;
    color: #1f2937;
  }
`;

export interface SelectedInfo {
  id: string;
  name: string;
  isJinja: boolean;
  /** Catalog part id, if the component was inserted from the parts catalog. */
  partId?: string;
}

export function useGrapes() {
  const editor = shallowRef<Editor>();
  const selected = ref<SelectedInfo | null>(null);
  const zoom = ref(1);
  /** Canvas read-only flag (mirrors !allowEdit). Blocks RTE/drag while selectable. */
  let locked = false;
  /** Bumped on every component/style change so callers can recompute geometry. */
  const revision = ref(0);
  /** Screen rect of the selected element (canvas-relative, zoom-aware) for overlays. */
  const selectedRect = ref<SelectedRect | null>(null);
  const canMoveUp = ref(false);
  const canMoveDown = ref(false);
  /** Whether the current selection can be drag-reordered (drives the move grip). */
  const canDragSelected = ref(false);
  /** Page-boundary overlay guides (see {@link refreshPageGuides}). */
  const pageGuides = ref<PageGuide[]>([]);
  /**
   * Page-break elements cached by {@link recomputeBreakEls}; their on-screen
   * positions are re-read each scroll/zoom by {@link refreshPageGuides}.
   */
  let breakEls: { el: HTMLElement; edge: 'before' | 'after' }[] = [];
  /** Editor → caller notifications, installed via the `onX` setters below. */
  const callbacks: GrapesCallbacks = {};

  function refreshMove(): void {
    const comp = editor.value?.getSelected();
    canDragSelected.value = !locked && !!comp?.get('draggable');
    const parent = comp?.parent();
    if (!comp || !parent) {
      canMoveUp.value = false;
      canMoveDown.value = false;
      return;
    }
    const i = comp.index();
    canMoveUp.value = i > 0;
    canMoveDown.value = i < parent.components().length - 1;
  }

  /** True for the page-break keywords used by `break-*` / `page-break-*`. */
  function isBreakValue(v: string | undefined): boolean {
    return (
      v === 'always' ||
      v === 'page' ||
      v === 'left' ||
      v === 'right' ||
      v === 'recto' ||
      v === 'verso'
    );
  }

  /**
   * Scan the canvas document for elements that start/end a printed page, via
   * `break-before/after` or the legacy `page-break-*` — including class-driven
   * rules like `.page { page-break-after: always }`, which only show up in
   * computed style (the inline-only `geomFromStyle` would miss them). Heavy (reads
   * computed style for every node) so it runs on content/style changes only;
   * {@link refreshPageGuides} reuses the cached set on scroll/zoom.
   */
  function recomputeBreakEls(): void {
    const ed = editor.value;
    const doc = ed?.Canvas.getDocument();
    const win = doc?.defaultView;
    const body = ed?.Canvas.getBody();
    if (!doc || !win || !body) {
      breakEls = [];
      return;
    }
    const out: { el: HTMLElement; edge: 'before' | 'after' }[] = [];
    for (const el of Array.from(body.querySelectorAll<HTMLElement>('*'))) {
      const cs = win.getComputedStyle(el);
      if (isBreakValue(cs.breakBefore || cs.pageBreakBefore)) out.push({ el, edge: 'before' });
      if (isBreakValue(cs.breakAfter || cs.pageBreakAfter)) out.push({ el, edge: 'after' });
    }
    breakEls = out;
  }

  /**
   * Recompute the page-boundary guide lines as a *physical page* model over the
   * continuous canvas (where `page-break-*` has no on-screen layout effect):
   *
   * - Each cached break (`.page` end, `break-*`/`page-break-*`) is a hard break =
   *   the end of a logical page → solid `break` guide.
   * - Within the span between two hard breaks (and before the first), content
   *   that overruns one printable page height `H` is split into more physical
   *   pages → dashed `estimate` sub-guides every `H`.
   * - Every guide is numbered by the *cumulative* physical page, so the labels
   *   stay correct even when a block paginates into several sheets.
   *
   * `H` comes from {@link pageContentPx} (`@page` margins), zoom-scaled to match
   * `getElementPos` coords. The exact pagination remains the Vivliostyle
   * preview's job; this is the in-editor approximation.
   */
  function refreshPageGuides(): void {
    const ed = editor.value;
    const body = ed?.Canvas.getBody();
    if (!ed || !body) {
      pageGuides.value = [];
      return;
    }
    try {
      const bodyPos = ed.Canvas.getElementPos(body);
      const top0 = bodyPos.top;
      const bottom = bodyPos.top + bodyPos.height;
      const H = pageContentPx(getCss()) * zoom.value; // one printable page (screen px)

      // Hard breaks (logical page ends), sorted, dropping ones hugging the edges.
      const hard = breakEls
        .map(({ el, edge }) => {
          const p = ed.Canvas.getElementPos(el);
          return edge === 'before' ? p.top : p.top + p.height;
        })
        .filter((t) => t > top0 + 1 && t < bottom - 1)
        .sort((a, b) => a - b);

      // Walk top→bottom: each span [regionStart, stop] gets H-sized estimate
      // sub-guides for overflow, then a solid guide at the hard break (stops at
      // the sheet bottom carry no line — the last page end is the edge itself).
      const guides: PageGuide[] = [];
      const stops = [...hard, bottom];
      let pageNo = 0;
      let regionStart = top0;
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const isHard = i < hard.length;
        for (let y = regionStart + H; y < stop - 1; y += H) {
          // collapse near-duplicates (a sub-guide landing on the next hard break)
          if (stop - y < 1) break;
          pageNo++;
          guides.push({
            top: y,
            left: bodyPos.left,
            width: bodyPos.width,
            page: pageNo,
            kind: 'estimate',
          });
        }
        pageNo++;
        if (isHard) {
          guides.push({
            top: stop,
            left: bodyPos.left,
            width: bodyPos.width,
            page: pageNo,
            kind: 'break',
          });
        }
        regionStart = stop;
      }
      pageGuides.value = guides;
    } catch (e) {
      // Geometry recompute failed (transient canvas state) — hide guides quietly.
      logError(toAppError(e));
      pageGuides.value = [];
    }
  }

  /** Recompute the selected element's on-screen rect (for the floating toolbar/handles). */
  function refreshRect(): void {
    const ed = editor.value;
    const comp = ed?.getSelected();
    const el = comp?.getEl?.();
    if (!ed || !el) {
      selectedRect.value = null;
      return;
    }
    try {
      const p = ed.Canvas.getElementPos(el);
      selectedRect.value = { left: p.left, top: p.top, width: p.width, height: p.height };
    } catch (e) {
      // Geometry recompute failed (transient canvas state) — log for observability
      // but keep the toolbar hidden rather than surfacing a toast to the user.
      logError(toAppError(e));
      selectedRect.value = null;
    }
  }

  function init(c: GrapesContainers): Editor {
    const ed = grapesjs.init({
      container: c.canvas,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      panels: { defaults: [] },
      // Style/Trait/Selector managers are intentionally left unmounted (no
      // appendTo): the right pane shows read-only part properties instead.
      selectorManager: { componentFirst: true },
      layerManager: { appendTo: c.layers },
      assetManager: { custom: true },
      // Blank GrapesJS' default cssIcons (a cdnjs Font Awesome <link>) so nothing
      // is fetched from a CDN. The FA glyphs its layer/toolbar icons use are
      // instead bundled locally via `import 'font-awesome/...'` in main.ts.
      cssIcons: '',
    });

    registerJinjaComponents(ed);

    wireGrapesEvents(ed, {
      selected,
      selectedRect,
      revision,
      zoom,
      refreshRect,
      refreshMove,
      recomputeBreakEls,
      refreshPageGuides,
      toInfo,
      isLocked: () => locked,
      canvasCss: `${jinjaChipCanvasCss}\n${a4CanvasCss}`,
      callbacks,
    });

    editor.value = ed;
    return ed;
  }

  function setZoom(z: number): void {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    zoom.value = clamped;
    editor.value?.Canvas.setZoom(clamped * 100);
    requestAnimationFrame(() => {
      refreshRect();
      refreshPageGuides();
    });
  }

  /**
   * Toggle canvas editability. When `on` is false the canvas is read-only:
   * components stay selectable (so the inspector works) but cannot be text-edited
   * or dragged. Jinja components keep their own defaults.
   */
  function setEditable(on: boolean): void {
    locked = !on;
    const ed = editor.value;
    if (!ed) return;
    ed.getWrapper()?.onAll((c) => {
      const type = String(c.get('type') ?? '');
      if (type.startsWith('jinja-')) return; // preserve jinja locked behavior
      c.set('editable', on);
      c.set('draggable', on);
      c.set('selectable', true);
    });
  }

  /**
   * Begin a native drag-to-reorder of the current selection. Invokes GrapesJS'
   * built-in move command with the originating mousedown so the Sorter takes
   * over; emits component:drag:start/end (wired in {@link init}).
   */
  function startMove(e: MouseEvent): void {
    const ed = editor.value;
    if (!ed || locked || !ed.getSelected()) return;
    try {
      ed.runCommand('tlb-move', { event: e });
    } catch {
      /* move command unavailable — ignore */
    }
  }

  /** Move the selection up (-1) or down (+1) among its siblings. */
  function moveSelected(dir: -1 | 1): void {
    const ed = editor.value;
    const comp = ed?.getSelected();
    const parent = comp?.parent();
    if (!ed || !comp || !parent) return;
    const i = comp.index();
    const total = parent.components().length;
    const j = i + dir;
    if (j < 0 || j >= total) return;
    // move() inserts at the target index of the current list; moving down needs +1
    comp.move(parent, { at: dir > 0 ? j + 1 : j });
    ed.select(comp);
  }

  /** Remove the current selection. */
  function deleteSelected(): void {
    editor.value?.getSelected()?.remove();
  }

  /** Inline style map of the current selection (empty when nothing selected). */
  function selectedStyle(): Record<string, string> {
    return (editor.value?.getSelected()?.getStyle() ?? {}) as Record<string, string>;
  }

  /** Apply an inline-style patch to the selection ('' values remove the prop). */
  function patchSelectedStyle(patch: Record<string, string>): void {
    const comp = editor.value?.getSelected();
    if (!comp) return;
    const next: Record<string, string> = { ...(comp.getStyle() as Record<string, string>) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') delete next[k];
      else next[k] = v;
    }
    comp.setStyle(next);
    // Programmatic setStyle doesn't emit the StyleManager 'style:update' event,
    // so notify listeners (autosave) and refresh derived state ourselves.
    revision.value++;
    refreshRect();
    callbacks.change?.();
  }

  function toInfo(comp: Component): SelectedInfo {
    const type = comp.get('type') ?? '';
    const partId = comp.getAttributes()['data-part-id'];
    return {
      id: comp.getId(),
      name: (comp.get('name') as string) || comp.get('tagName') || 'element',
      isJinja: typeof type === 'string' && type.startsWith('jinja-'),
      partId: typeof partId === 'string' ? partId : undefined,
    };
  }

  /** Insert a catalog part's HTML after the current selection (or at the end). */
  function insertPart(content: string, partId: string): void {
    const ed = editor.value;
    if (!ed) return;
    const sel = ed.getSelected();
    const parent = sel?.parent();
    const added =
      parent && sel
        ? parent.append(content, { at: sel.index() + 1 })
        : ed.getWrapper()?.append(content);
    const root = Array.isArray(added) ? added[0] : added;
    // tag with the catalog id so a later canvas selection resolves back to docs
    root?.addAttributes?.({ 'data-part-id': partId });
    if (root) ed.select(root); // select the inserted part, like the prototype
  }

  function load(bodyEditableHtml: string, css: string): void {
    const ed = editor.value;
    if (!ed) return;
    ed.setComponents(bodyEditableHtml);
    ed.setStyle(css);
  }

  function getBodyHtml(): string {
    return editor.value?.getHtml() ?? '';
  }

  function getCss(): string {
    return editor.value?.getCss() ?? '';
  }

  function onChange(cb: () => void): void {
    callbacks.change = cb;
  }

  /** Inline text edit started (RTE enabled) — good time to snapshot for undo. */
  function onTextEditStart(cb: () => void): void {
    callbacks.textStart = cb;
  }
  /** Inline text edit ended; `changed` is true only if the content differs. */
  function onTextEditEnd(cb: (changed: boolean) => void): void {
    callbacks.textEnd = cb;
  }

  /** A canvas drag-reorder started — good time to snapshot for undo. */
  function onReorderStart(cb: () => void): void {
    callbacks.reorderStart = cb;
  }
  /** A canvas drag-reorder ended; `moved` is true only if the order changed. */
  function onReorderEnd(cb: (moved: boolean) => void): void {
    callbacks.reorderEnd = cb;
  }

  function destroy(): void {
    editor.value?.destroy();
    editor.value = undefined;
  }

  return {
    editor,
    selected,
    selectedRect,
    canMoveUp,
    canMoveDown,
    canDragSelected,
    pageGuides,
    zoom,
    revision,
    init,
    load,
    insertPart,
    getBodyHtml,
    getCss,
    onChange,
    onTextEditStart,
    onTextEditEnd,
    onReorderStart,
    onReorderEnd,
    setZoom,
    setEditable,
    refreshRect,
    refreshPageGuides,
    startMove,
    moveSelected,
    deleteSelected,
    selectedStyle,
    patchSelectedStyle,
    destroy,
  };
}
