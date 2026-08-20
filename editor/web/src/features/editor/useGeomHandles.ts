// =============================================================================
// useGeomHandles.ts — 選択ブロックのリサイズ / 余白ドラッグハンドル
// =============================================================================
// 役割: `EditorView.vue` のドラッグハンドルを駆動し、選択ブロックの幅 / 上下余白を
// zoom 非依存で編集する composable。

import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { clampMarginMm, clampWidthPct, type LayoutGeom, PX_PER_MM, WIDTH_PCT_MAX } from './geom';
import type { SelectedRect } from './grapesEvents';

/** どの edge/corner ハンドルをドラッグ中か。 */
type HandleKind = 'width' | 'width-left' | 'mt' | 'mb';

interface GeomHandleDeps {
  /** 現在の選択の幾何(未選択時は null)。 */
  selectedGeom: ComputedRef<LayoutGeom | null>;
  /** canvas overlay 上での現在の選択のピクセル rect。 */
  selectedRect: Ref<SelectedRect | null>;
  /** 現在の canvas zoom(余白は zoom 非依存の mm で測る)。 */
  zoom: Ref<number>;
  /** undo を 1 ステップ積む(drag 開始時に 1 度だけ呼ぶ)。 */
  /** drag 開始時の snapshot を保留する(確定/破棄は `recordGeomDiff` 側が決める)。 */
  beginUndo: () => void;
  /** 幾何パッチを適用する。`record=false` でライブ drag、true で history を記録。 */
  applyGeom: (patch: Partial<LayoutGeom>, record?: boolean) => void;
  /** drag 後の幾何 diff を history へ 1 件記録する。 */
  recordGeomDiff: (before: LayoutGeom) => void;
}

/**
 * `EditorView.vue` 用の zoom 非依存なブロック resize/余白ドラッグハンドル。
 *
 * 'width'/'width-left' はブロック幅を resize する(左側は delta を反転させ、ハンドルが
 * カーソルに追従するようにする)。'mt'/'mb' は上/下の余白を調整する。drag は
 * ライブに(記録なしで)適用し、幾何が動いた場合だけ 1 ジェスチャにつき undo 1 件 +
 * history 1 件を記録する。
 * window listener は drag 中だけ attach する。
 */
export function useGeomHandles(deps: GeomHandleDeps) {
  const { selectedGeom, selectedRect, zoom, beginUndo, applyGeom, recordGeomDiff } = deps;

  const activeHandle = ref<HandleKind | null>(null);
  let drag: { kind: HandleKind; x: number; y: number; geom: LayoutGeom; fullW: number } | null =
    null;

  function startHandle(kind: HandleKind, e: MouseEvent) {
    const g0 = selectedGeom.value;
    const r = selectedRect.value;
    if (!g0 || !r) return;
    e.preventDefault();
    e.stopPropagation();
    // drag 1 回につき undo 1 ステップ。幾何が動かなければ `recordGeomDiff` が保留を捨てる。
    beginUndo();
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
      // 記録なしでライブ適用(history は mouseup で 1 度だけ記録する)
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

  /** ドラッグ中のハンドル横に表示するライブ値の bubble。 */
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
