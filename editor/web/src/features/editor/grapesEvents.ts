import type { Component, Editor } from 'grapesjs';
import type { Ref } from 'vue';
import type { SelectedInfo } from './useGrapes';

/** Screen rect of the selected element (canvas-relative, zoom-aware) for overlays. */
export interface SelectedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Editor → caller notifications. Mutable so {@link useGrapes}'s `onChange` etc.
 * can install handlers after the editor is wired; the listeners read the current
 * value at fire time.
 */
export interface GrapesCallbacks {
  change?: () => void;
  textStart?: () => void;
  textEnd?: (changed: boolean) => void;
  reorderStart?: () => void;
  reorderEnd?: (moved: boolean) => void;
}

export interface GrapesEventDeps {
  selected: Ref<SelectedInfo | null>;
  selectedRect: Ref<SelectedRect | null>;
  /** Bumped on every component/style change so callers can recompute geometry. */
  revision: Ref<number>;
  zoom: Ref<number>;
  refreshRect: () => void;
  refreshMove: () => void;
  /** Rescan the canvas for page-break elements (content/style changes only). */
  recomputeBreakEls: () => void;
  /** Re-read page-boundary guide positions (scroll/zoom/content changes). */
  refreshPageGuides: () => void;
  toInfo: (comp: Component) => SelectedInfo;
  /** Canvas read-only flag getter (blocks RTE while selectable). */
  isLocked: () => boolean;
  /** Combined jinja + A4 styles injected into the canvas document on load. */
  canvasCss: string;
  callbacks: GrapesCallbacks;
}

/**
 * Register all GrapesJS editor listeners for the custom 3-pane editor. Extracted
 * from {@link useGrapes} so `init()` stays small; the event semantics, names, and
 * order are unchanged from the inline version.
 */
export function wireGrapesEvents(ed: Editor, deps: GrapesEventDeps): void {
  const {
    selected,
    selectedRect,
    revision,
    zoom,
    refreshRect,
    refreshMove,
    recomputeBreakEls,
    refreshPageGuides,
    toInfo,
    callbacks,
  } = deps;
  // Local to the listeners: RTE start snapshot and the drag-start sibling index.
  let rteStartHtml = '';
  let dragStartIndex = -1;

  ed.on('load', () => {
    const docu = ed.Canvas.getDocument();
    if (docu) {
      const styleEl = docu.createElement('style');
      styleEl.textContent = deps.canvasCss;
      docu.head.appendChild(styleEl);
    }
    // open at 100% (fixed; manual +/- adjusts from there)
    try {
      ed.Canvas.setZoom(zoom.value * 100);
    } catch {
      /* zoom API unavailable — ignore */
    }
    // page-boundary guides: scan once now that styles/components are in place
    recomputeBreakEls();
    refreshPageGuides();
  });

  ed.on('component:selected', () => {
    const comp = ed.getSelected();
    selected.value = comp ? toInfo(comp) : null;
    refreshRect();
    refreshMove();
  });
  ed.on('component:deselected', () => {
    selected.value = null;
    selectedRect.value = null;
    refreshMove();
  });
  // scroll: positions only (reuse the cached break-element set — cheap)
  const onScroll = () => {
    refreshRect();
    refreshPageGuides();
  };
  ed.on('canvas:scroll', onScroll);
  ed.on('canvas:update frame:scroll', onScroll);

  const fireChange = () => {
    revision.value++;
    refreshRect();
    refreshMove();
    // content/style may have added/removed page breaks — rescan, then reposition
    recomputeBreakEls();
    refreshPageGuides();
    callbacks.change?.();
  };
  // inline text editing (RTE): notify start (for an undo snapshot) and end
  // (with whether the content actually changed). Blocked while locked.
  ed.on('rte:enable', (view: { el?: HTMLElement }) => {
    if (deps.isLocked()) {
      // Belt-and-suspenders: components are set editable:false when locked, so
      // RTE shouldn't enable, but bail out defensively if it ever does.
      try {
        ed.stopCommand('core:component-edit');
      } catch {
        /* command unavailable — ignore */
      }
      return;
    }
    rteStartHtml = view?.el?.innerHTML ?? '';
    callbacks.textStart?.();
  });
  ed.on('rte:disable', (view: { el?: HTMLElement }) => {
    const changed = (view?.el?.innerHTML ?? '') !== rteStartHtml;
    if (changed) {
      revision.value++;
      refreshRect();
      refreshPageGuides(); // edited text can change the sheet height / boundaries
      callbacks.change?.();
    }
    callbacks.textEnd?.(changed);
  });

  ed.on('component:update', fireChange);
  ed.on('component:add', fireChange);
  ed.on('component:remove', fireChange);
  ed.on('style:update', fireChange);

  // native drag-to-reorder: snapshot for undo on start, record history on end
  // (only when the component actually changed siblings position). Read the
  // selection directly rather than trusting the (version-specific) payload.
  ed.on('component:drag:start', () => {
    dragStartIndex = ed.getSelected()?.index?.() ?? -1;
    callbacks.reorderStart?.();
  });
  ed.on('component:drag:end', () => {
    const moved = (ed.getSelected()?.index?.() ?? -1) !== dragStartIndex;
    callbacks.reorderEnd?.(moved);
  });
}
