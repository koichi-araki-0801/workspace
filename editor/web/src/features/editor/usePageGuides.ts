// =============================================================================
// usePageGuides.ts — ページ境界 guide の算出
// =============================================================================
// 役割: `useGrapes.ts` が `splitPages` で分けたページ(`pageBlocks`)と数えた区切り(`breakEls`)
// から、ページの境目ごとに guide 線の座標を出す(`refreshPageGuides`)。ページの分け方はここで
// 判定し直さない — canvas のページ数・1 ページ表示・承認タブと同じ `splitPages` の結果だけを使う
// ので、線の本数は必ず `pageCount - 1` になる。

import { toAppError } from '@editor/shared';
import type { Editor } from 'grapesjs';
import { ref, type ShallowRef } from 'vue';
import { logError } from '@/lib/appError';

/**
 * A4 sheet 上に描く 1 本のページ境界 guide(canvas 相対 / zoom 考慮の座標、
 * `SelectedRect` と同様)。`splitPages` で分けたページの境目 1 つに 1 本。297mm の高さ推定
 * (estimate)は描かない(厳密な改ページは Vivliostyle preview の役目)。
 * `useTemplateEditor` の推論戻り値型が参照するため export が必要(TS4058 回避)。 @public
 */
export interface PageGuide {
  top: number;
  left: number;
  width: number;
  /** この境界で*終わる*累積ページ番号(「ここまで N ページ目」)。 */
  page: number;
}

interface PageGuidesContext {
  editor: ShallowRef<Editor | undefined>;
  /** ページごとのパーツ(`useGrapes.ts` の `pageBlocks`。区切りの要素は含まない)。 */
  pageBlocks: ShallowRef<HTMLElement[][]>;
  /** 数えた区切りの要素(`splitPages` の `breakEls`。先頭・末尾・連続のものも含む)。 */
  breakEls: ShallowRef<HTMLElement[]>;
  /** guide と同じ scroll/zoom/content の契機で連動再計測するフック(メモ目印)。 */
  afterGuides?: () => void;
}

/** `a` が文書順で `b` より前にあるか。 */
function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

export function usePageGuides(ctx: PageGuidesContext) {
  /** ページ境界の overlay guide 群(`refreshPageGuides` を見よ)。 */
  const pageGuides = ref<PageGuide[]>([]);

  /**
   * 連続スクロールの canvas(`page-break-*` は画面レイアウトに効かない)の上に、ページ境界
   * guide 線を再計算する。ページ `i`(1 以上)の先頭のパーツの上端に 1 本ずつ引き、番号は `i`
   * (「ここまで i ページ目」)。前のページの末尾のパーツとの間に区切りの帯が描かれていれば、
   * 最初の帯の上端に引く(帯の下に線が来ると、帯と線が離れて見えるため)。高さ 0 の帯(テンプレの
   * CSS で消えているなど)は描かれていないとみなす。位置は scroll/zoom のたびに測り直すが、
   * ページの集合は content 変更時に `useGrapes.ts` が数え直したものを使う。
   */
  function refreshPageGuides(): void {
    const ed = ctx.editor.value;
    const body = ed?.Canvas.getBody();
    if (!ed || !body) {
      pageGuides.value = [];
      return;
    }
    try {
      // `noScroll: true`: 既定の `getElementPos` は内部 `offset()` で iframe document の
      // scroll 量を足し戻し、戻り値が content 基準(scroll 非依存)になる。overlay guide は
      // 非スクロールの `<main>` 上に置くため、iframe スクロール時に追従させるには viewport
      // 相対が要る。GrapesJS 自身も tool 配置で同じ opts を使う(grapesjs canvas の
      // `CommandSelectComponent.getElementPos`)。`refreshRect` も同様。
      const pos = (el: HTMLElement) => ed.Canvas.getElementPos(el, { noScroll: true });
      const bodyPos = pos(body);
      const pages = ctx.pageBlocks.value;
      const breaks = ctx.breakEls.value;
      const out: PageGuide[] = [];
      for (let i = 1; i < pages.length; i++) {
        const first = pages[i][0];
        const prevLast = pages[i - 1].at(-1);
        if (!first) continue;
        const band = breaks
          .filter((b) => (!prevLast || precedes(prevLast, b)) && precedes(b, first))
          .map(pos)
          .find((p) => p.height > 0);
        out.push({
          top: band ? band.top : pos(first).top,
          left: bodyPos.left,
          width: bodyPos.width,
          page: i,
        });
      }
      pageGuides.value = out;
    } catch (e) {
      // 幾何の再計算に失敗(canvas の一時的な状態) — guide を静かに隠す。
      logError(toAppError(e));
      pageGuides.value = [];
    }
    // guide と同じ scroll/zoom/content の契機でメモ目印も測り直す(位置追従)。
    ctx.afterGuides?.();
  }

  return { pageGuides, refreshPageGuides };
}
