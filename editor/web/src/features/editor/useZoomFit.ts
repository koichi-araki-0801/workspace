// =============================================================================
// useZoomFit.ts — canvas の zoom / フィット / 縦配置切替(useGrapes から分離)
// =============================================================================
// 役割: zoom 値の保持と `Canvas.setZoom` への反映、A4 ページ全体が収まる倍率への
// フィット(`fitToView`)、収まり判定による縦配置 class の出し分け(`updateScrollMode`)。
// 依存(editor / コンテナ / ズーム後の overlay 再計測)は `ctx` で受け、状態は持ち込まない。

import type { Editor } from 'grapesjs';
import { ref, type ShallowRef } from 'vue';

// canvas の zoom 範囲とクリック毎のステップ。`EditorView.vue` の zoom in/out ボタンと
// 共有し、`setZoom` と同じ範囲へ clamp させる。
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.4;
export const ZOOM_STEP = 0.1;

// `fitToView` で利用可能サイズから差し引く余白(px)。これを引いた領域へ A4 ページ全体が
// 収まる倍率を求める。`index.css` の `.gjs-frame-wrapper{ margin:auto; top/bottom:0 }` で
// ページは canvas 中央へ上下対称に寄せるため、この余白が上下に半分(28px)ずつ分かれて見える。
const FIT_MARGIN = 56;

interface ZoomFitContext {
  editor: ShallowRef<Editor | undefined>;
  /** zoom フィット計測の基準になる canvas コンテナ(`init` 後に確定するため getter で受ける)。 */
  getContainer: () => HTMLElement | undefined;
  /** `setZoom` の rAF 内で overlay(選択枠 / guide / メモ印)を測り直すフック。 */
  afterZoom: () => void;
}

export function useZoomFit(ctx: ZoomFitContext) {
  const zoom = ref(1);

  function setZoom(z: number): void {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    zoom.value = clamped;
    ctx.editor.value?.Canvas.setZoom(clamped * 100);
    requestAnimationFrame(() => {
      updateScrollMode();
      ctx.afterZoom();
    });
  }

  /**
   * ページ全体がビューポートに収まるかを判定し、コンテナに `ret-canvas-fits` class を
   * 出し分ける(index.css の `.gjs-frame-wrapper` 縦配置を切り替える)。収まる時は縦中央寄せ、
   * 超える時は上揃え + 縦スクロール。判定は `fitToView` と同じ尺度(ページ実寸 `offset*` に zoom を
   * 掛けた表示サイズ vs `client* - FIT_MARGIN`)。`setZoom`/`fitToView`/canvas load の各 rAF で呼ぶ。
   */
  function updateScrollMode(): void {
    const containerEl = ctx.getContainer();
    if (!containerEl) return;
    const body = ctx.editor.value?.Canvas.getBody();
    const fits =
      !!body &&
      body.offsetHeight * zoom.value <= containerEl.clientHeight - FIT_MARGIN &&
      body.offsetWidth * zoom.value <= containerEl.clientWidth - FIT_MARGIN;
    containerEl.classList.toggle('ret-canvas-fits', fits);
  }

  /**
   * canvas を A4 ページ全体が縦横とも収まる倍率へ合わせる(起動時の初期ズーム用)。
   * ページ実寸は body の `offsetHeight/offsetWidth`(CSS px、transform 非依存なので
   * `setZoom` の scale に影響されない)で測り、利用可能サイズは canvas コンテナの
   * client サイズから `FIT_MARGIN` を引いた値とする。両軸の min を取り `setZoom` に委譲
   * (clamp `[ZOOM_MIN, ZOOM_MAX]` / 丸め / overlay 再計算はそちら任せ)。以後は手動 +/- で調整。
   */
  function fitToView(): void {
    const containerEl = ctx.getContainer();
    const body = ctx.editor.value?.Canvas.getBody();
    if (!body || !containerEl) return;
    const availH = containerEl.clientHeight - FIT_MARGIN;
    const availW = containerEl.clientWidth - FIT_MARGIN;
    const pageH = body.offsetHeight;
    const pageW = body.offsetWidth;
    if (pageH <= 0 || pageW <= 0 || availH <= 0 || availW <= 0) return;
    setZoom(Math.min(availH / pageH, availW / pageW));
    // `setZoom` 側の rAF でも更新されるが、フィット直後の class を確実に揃えておく。
    updateScrollMode();
  }

  return { zoom, setZoom, fitToView, updateScrollMode };
}
