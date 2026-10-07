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
  /** canvas の inline text 編集(RTE)中か。 */
  isTextEditing: () => boolean;
  /**
   * テキスト編集を閉じ、入力をモデルへ反映する。閉じられなかったら false で、そのときは drag を
   * 始めない(利用者へは `useGrapes.ts` の `finishTextEdit` が知らせる)。
   */
  finishTextEdit: () => Promise<boolean>;
}

/**
 * `EditorView.vue` 用の zoom 非依存なブロック resize/余白ドラッグハンドル。
 *
 * 'width'/'width-left' はブロック幅を resize する(左側は delta を反転させ、ハンドルが
 * カーソルに追従するようにする)。'mt'/'mb' は上/下の余白を調整する。drag は
 * ライブに(記録なしで)適用し、幾何が動いた場合だけ 1 ジェスチャにつき undo 1 件 +
 * history 1 件を記録する。
 *
 * ハンドルは canvas の iframe の上に重なる。ハンドルの外へ出ると、移動と離す操作が iframe の
 * 文書へ届いて親の window に来ず、drag が追随しないまま離しても終わらない。押下で pointer を
 * ハンドルへ捕まえ(`setPointerCapture`)、以後の pointer イベントをすべてハンドル経由で受ける。
 * iframe の `pointer-events` を drag の間だけ切る方法は、iframe の状態を書き換えて戻し忘れの経路を
 * 増やすので採らない。捕まえたイベントは window まで bubble するので、listener は window に
 * drag 中だけ attach する。
 */
export function useGeomHandles(deps: GeomHandleDeps) {
  const {
    selectedGeom,
    selectedRect,
    zoom,
    beginUndo,
    applyGeom,
    recordGeomDiff,
    isTextEditing,
    finishTextEdit,
  } = deps;

  const activeHandle = ref<HandleKind | null>(null);
  let drag: { kind: HandleKind; x: number; y: number; geom: LayoutGeom; fullW: number } | null =
    null;

  function startHandle(kind: HandleKind, e: PointerEvent) {
    if (!selectedGeom.value || !selectedRect.value) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as Element | null;
    target?.setPointerCapture?.(e.pointerId);
    const { clientX: x, clientY: y } = e;
    if (!isTextEditing()) {
      beginDrag(kind, x, y);
      return;
    }
    // 伝播と既定動作を止める(互換の mousedown も出ない)ので、GrapesJS が document の mousedown で
    // 閉じるテキスト編集はここでは閉じない。
    // 閉じる前に drag を始めると、モデルへ未反映の追記が幾何の 1 手に混ざる。閉じ終えてから、
    // 押した位置を起点に同じ押下で drag を始める(閉じる処理は microtask で終わる)。閉じ終わる前に
    // 離されていたら始めない — 離した後に始めると、来ない pointerup を待ち続ける。
    let released = false;
    const onEarlyUp = () => {
      released = true;
    };
    window.addEventListener('pointerup', onEarlyUp, { once: true });
    window.addEventListener('pointercancel', onEarlyUp, { once: true });
    void finishTextEdit().then((closed) => {
      window.removeEventListener('pointerup', onEarlyUp);
      window.removeEventListener('pointercancel', onEarlyUp);
      if (closed && !released) beginDrag(kind, x, y);
    });
  }

  function beginDrag(kind: HandleKind, x: number, y: number) {
    const g0 = selectedGeom.value;
    const r = selectedRect.value;
    if (!g0 || !r) return;
    // drag 1 回につき undo 1 ステップ。幾何が動かなければ `recordGeomDiff` が保留を捨てる。
    beginUndo();
    activeHandle.value = kind;
    drag = {
      kind,
      x,
      y,
      geom: { ...g0 },
      fullW: r.width / (Math.max(g0.widthPct, 1) / 100),
    };
    window.addEventListener('pointermove', onHandleMove);
    window.addEventListener('pointerup', onHandleUp);
    window.addEventListener('pointercancel', onHandleUp);
    // drag 中にハンドルが `v-if` で外れると捕まえも外れ、pointerup が来ないまま drag と Undo の
    // 保留が残る。捕まえが外れたら離したのと同じく片付ける(document へ出て window まで bubble する)。
    window.addEventListener('lostpointercapture', onHandleUp);
  }

  function onHandleMove(e: PointerEvent) {
    if (!drag) return;
    const z = zoom.value;
    if (drag.kind === 'width' || drag.kind === 'width-left') {
      const sign = drag.kind === 'width-left' ? -1 : 1;
      const dPct = ((e.clientX - drag.x) / drag.fullW) * 100 * sign;
      const w = Math.round(clampWidthPct(drag.geom.widthPct + dPct));
      // 記録なしでライブ適用(history は pointerup で 1 度だけ記録する)
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
    window.removeEventListener('pointermove', onHandleMove);
    window.removeEventListener('pointerup', onHandleUp);
    window.removeEventListener('pointercancel', onHandleUp);
    window.removeEventListener('lostpointercapture', onHandleUp);
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
