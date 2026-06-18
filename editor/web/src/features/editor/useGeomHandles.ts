import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { clampMarginMm, clampWidthPct, type LayoutGeom, PX_PER_MM, WIDTH_PCT_MAX } from './geom';
import type { SelectedRect } from './grapesEvents';

/** Which edge/corner handle is being dragged. */
export type HandleKind = 'width' | 'width-left' | 'mt' | 'mb';

interface GeomHandleDeps {
  /** Geometry of the current selection (null when nothing is selected). */
  selectedGeom: ComputedRef<LayoutGeom | null>;
  /** Pixel rect of the current selection on the canvas overlay. */
  selectedRect: Ref<SelectedRect | null>;
  /** Current canvas zoom (margins are measured in zoom-independent mm). */
  zoom: Ref<number>;
  /** Push one undo step (called once at drag start). */
  pushUndo: () => void;
  /** Apply a geometry patch; `record=false` for live drag, true to log history. */
  applyGeom: (patch: Partial<LayoutGeom>, record?: boolean) => void;
  /** Record a single history entry for the geometry diff after a drag. */
  recordGeomDiff: (before: LayoutGeom) => void;
}

/**
 * Zoom-independent block resize/margin drag handles for {@link EditorView}.
 *
 * 'width'/'width-left' resize the block width (the left side inverts the delta so
 * the handle follows the cursor); 'mt'/'mb' adjust the top/bottom margins. The
 * drag applies live (without recording) and logs one undo + one history entry per
 * gesture. Window listeners are attached for the duration of a drag only.
 */
export function useGeomHandles(deps: GeomHandleDeps) {
  const { selectedGeom, selectedRect, zoom, pushUndo, applyGeom, recordGeomDiff } = deps;

  const activeHandle = ref<HandleKind | null>(null);
  let drag: { kind: HandleKind; x: number; y: number; geom: LayoutGeom; fullW: number } | null =
    null;

  function startHandle(kind: HandleKind, e: MouseEvent) {
    const g0 = selectedGeom.value;
    const r = selectedRect.value;
    if (!g0 || !r) return;
    e.preventDefault();
    e.stopPropagation();
    pushUndo(); // one undo step per drag
    activeHandle.value = kind;
    drag = {
      kind,
      x: e.clientX,
      y: e.clientY,
      geom: { ...g0 },
      fullW: r.width / (Math.max(g0.widthPct, 1) / 100),
    };
    window.addEventListener('mousemove', onHandleMove);
    window.addEventListener('mouseup', onHandleUp);
  }

  function onHandleMove(e: MouseEvent) {
    if (!drag) return;
    const z = zoom.value;
    if (drag.kind === 'width' || drag.kind === 'width-left') {
      const sign = drag.kind === 'width-left' ? -1 : 1;
      const dPct = ((e.clientX - drag.x) / drag.fullW) * 100 * sign;
      const w = Math.round(clampWidthPct(drag.geom.widthPct + dPct));
      // live apply without recording (history is recorded once on mouseup)
      applyGeom(
        {
          widthPct: w,
          align:
            w >= WIDTH_PCT_MAX
              ? 'stretch'
              : drag.geom.align === 'stretch'
                ? 'left'
                : drag.geom.align,
        },
        false,
      );
    } else {
      const dmm = Math.round((e.clientY - drag.y) / z / PX_PER_MM);
      const key = drag.kind === 'mt' ? 'marginTop' : 'marginBottom';
      applyGeom({ [key]: clampMarginMm(drag.geom[key] + dmm) } as Partial<LayoutGeom>, false);
    }
  }

  function onHandleUp() {
    if (drag) recordGeomDiff(drag.geom);
    drag = null;
    activeHandle.value = null;
    window.removeEventListener('mousemove', onHandleMove);
    window.removeEventListener('mouseup', onHandleUp);
  }

  /** Live value bubble shown next to the handle being dragged. */
  const dragLabel = computed(() => {
    const k = activeHandle.value;
    const r = selectedRect.value;
    const gm = selectedGeom.value;
    if (!k || !r || !gm) return null;
    if (k === 'mt') return { left: r.left + r.width / 2, top: r.top, text: `上 ${gm.marginTop}mm` };
    if (k === 'mb')
      return { left: r.left + r.width / 2, top: r.top + r.height, text: `下 ${gm.marginBottom}mm` };
    const left = k === 'width-left' ? r.left : r.left + r.width;
    return { left, top: r.top + r.height / 2, text: `${gm.widthPct}%` };
  });

  return { activeHandle, startHandle, dragLabel };
}
