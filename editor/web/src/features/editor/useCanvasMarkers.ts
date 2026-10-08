// =============================================================================
// useCanvasMarkers.ts — 選択枠 rect とメモ目印の overlay 計測
// =============================================================================
// 役割: 選択要素の画面 rect(浮動ツールバー / ハンドル用)と、メモを持つパーツの目印位置を、
// canvas 相対 / zoom 考慮(`noScroll:true` の viewport 相対)で測る。
// ページ表示状態(currentPageIndex / singlePageMode)は `ctx` の ref を読む。ページの分け方は
// `partKey.ts` の `partEntries`(`useGrapes.ts` の `pageBlocks` と同じ `splitPages`)で読む。

import type { Editor } from 'grapesjs';
import { type Ref, ref, type ShallowRef } from 'vue';
import { canvasRoot, measureOrClear } from './canvasGeometry';
import type { SelectedRect } from './grapesEvents';
import { type BubbleAnchor, computeBubbleAnchor, sameBubbleAnchor } from './noteBubbleLayout';
import { canvasRawKey, partEntries } from './partKey';

/**
 * メモを持つパーツの目印(canvas 相対 / zoom 考慮の座標、`SelectedRect` と同様)。
 * エクセルのセルコメント風に、パーツ右上隅へ固定 px の小バッジを重畳する。位置のみ
 * パーツへ追従し、バッジ自体のサイズはズーム非依存(`refreshNoteMarkers` を見よ)。
 * `useTemplateEditor` の推論戻り値型が参照するため export が必要(TS4058 回避)。 @public
 */
export interface NoteMarker {
  /** 紐づく構造パスキー(`partKey.ts` の `partPathKeyFor`)。 */
  key: string;
  top: number;
  /** パーツ右上隅の x(`rect.left + rect.width`)。 */
  left: number;
}

interface CanvasMarkersContext {
  editor: ShallowRef<Editor | undefined>;
  currentPageIndex: Ref<number>;
  singlePageMode: Ref<boolean>;
  /** 吹き出し配置の基準になる canvas コンテナ(`useZoomFit` と同じ getter を渡す)。 */
  getContainer: () => HTMLElement | undefined;
}

export function useCanvasMarkers(ctx: CanvasMarkersContext) {
  /** overlay 用に保持する選択要素の画面 rect(canvas 相対, zoom 考慮)。 */
  const selectedRect = ref<SelectedRect | null>(null);
  /** メモを持つパーツの構造キー集合(外部 = `useComments` から `setNoteKeys` で注入)。 */
  const noteKeys = ref<Set<string>>(new Set());
  /** メモ目印の overlay 位置(`refreshNoteMarkers` が現在ページのパーツから算出)。 */
  const noteMarkers = ref<NoteMarker[]>([]);
  /** 吹き出しの配置(選択パーツが無い / 吹き出しを閉じている間は null)。 */
  const bubbleAnchor = ref<BubbleAnchor | null>(null);

  /** 選択要素の画面上 rect を再計算する(浮動ツールバー / ハンドル用)。 */
  function refreshRect(): void {
    const ed = ctx.editor.value;
    const comp = ed?.getSelected();
    const el = comp?.getEl?.();
    if (!ed || !el) {
      selectedRect.value = null;
      return;
    }
    // 失敗(canvas の一時的な状態)は toolbar を隠したままにする。
    measureOrClear(
      () => {
        // `noScroll: true`: overlay 相対の viewport 座標へ揃える(`refreshPageGuides` 参照)。
        const p = ed.Canvas.getElementPos(el, { noScroll: true });
        selectedRect.value = { left: p.left, top: p.top, width: p.width, height: p.height };
      },
      () => {
        selectedRect.value = null;
      },
    );
  }

  /**
   * メモを持つパーツ(`noteKeys`)の overlay 目印位置を再計算する。1 ページ表示中は現在
   * ページのパーツのみを走査する(非表示ページの `getElementPos` は 0 になり位置が崩れる
   * ため)。全ページ表示時は全ページを走査する。座標は `noScroll:true`(guide/rect と同様、
   * 非スクロールの overlay 層に重ねるための viewport 相対)で測る。
   */
  function refreshNoteMarkers(): void {
    const ed = ctx.editor.value;
    // 根は GrapesJS の wrapper(`useGrapes.ts` の `recomputePages` と同じ)。まだ描かれていなければ
    // 数えない。canvas の body の直下は wrapper 1 つで、パーツの並びではない。
    const root = canvasRoot(ctx.editor);
    if (!ed || !root || noteKeys.value.size === 0) {
      noteMarkers.value = [];
      return;
    }
    measureOrClear(
      () => {
        const out: NoteMarker[] = [];
        const single = ctx.singlePageMode.value;
        for (const { part, key, page } of partEntries(root, canvasRawKey(ed))) {
          if (single && page !== ctx.currentPageIndex.value) continue;
          if (!noteKeys.value.has(key)) continue;
          const p = ed.Canvas.getElementPos(part, { noScroll: true });
          out.push({ key, top: p.top, left: p.left + p.width });
        }
        noteMarkers.value = out;
      },
      () => {
        noteMarkers.value = [];
      },
    );
  }

  /** メモを持つパーツの構造キー集合を差し替え、目印を即時に測り直す(`useComments` から)。 */
  function setNoteKeys(keys: Set<string>): void {
    noteKeys.value = keys;
    refreshNoteMarkers();
  }

  /**
   * 選択パーツに紐づく吹き出しの配置を測り直す。ページ矩形は canvas body の
   * `getElementPos` で取り、コンテナ内寸は overlay 層の実寸を使う。吹き出しの実寸は
   * 描画後に呼び出し側が測って渡す(中身の件数で高さが変わるため)。
   *
   * 計算結果が現在の `bubbleAnchor.value` と値として同じなら代入しない(参照を保つ)。
   * ここで素通しに代入すると、`bubbleAnchor` を watch している側(`EditorView.vue` の
   * ページ左右寄せ)が参照差だけで再発火し、その中で呼ぶ再計測がまたここへ戻ってくる
   * 自己ループになる(`sameBubbleAnchor` のコメントを見よ)。
   */
  function refreshBubbleAnchor(bubble: { width: number; height: number } | null): void {
    const ed = ctx.editor.value;
    const comp = ed?.getSelected();
    const el = comp?.getEl?.();
    const body = ed?.Canvas.getBody();
    const containerEl = ctx.getContainer();
    if (!ed || !el || !body || !containerEl || !bubble) {
      if (!sameBubbleAnchor(bubbleAnchor.value, null)) bubbleAnchor.value = null;
      return;
    }
    measureOrClear(
      () => {
        const part = ed.Canvas.getElementPos(el, { noScroll: true });
        const page = ed.Canvas.getElementPos(body, { noScroll: true });
        const next = computeBubbleAnchor({
          part: { left: part.left, top: part.top, width: part.width, height: part.height },
          page: { left: page.left, width: page.width },
          container: { width: containerEl.clientWidth, height: containerEl.clientHeight },
          bubble,
        });
        if (!sameBubbleAnchor(bubbleAnchor.value, next)) bubbleAnchor.value = next;
      },
      () => {
        if (!sameBubbleAnchor(bubbleAnchor.value, null)) bubbleAnchor.value = null;
      },
    );
  }

  return {
    selectedRect,
    noteMarkers,
    bubbleAnchor,
    refreshRect,
    refreshNoteMarkers,
    refreshBubbleAnchor,
    setNoteKeys,
  };
}
