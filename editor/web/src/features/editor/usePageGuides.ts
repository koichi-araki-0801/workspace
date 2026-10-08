// =============================================================================
// usePageGuides.ts — ページ境界 guide の算出
// =============================================================================
// 役割: `useGrapes.ts` が `splitPages` で分けたページ(`pageBlocks`)と数えた区切り(`breakEls`)
// から、ページの境目ごとに guide 線の座標を出す(`refreshPageGuides`)。ページの分け方はここで
// 判定し直さない — canvas のページ数・1 ページ表示・承認タブと同じ `splitPages` の結果だけを使う
// ので、線の本数は `pageCount - 1` から要素の無い白紙のページの数を引いたものになる(白紙の
// ページの前後の線は同じ位置に来るので 1 本にまとめる)。

import type { Editor } from 'grapesjs';
import { ref, type ShallowRef } from 'vue';
import { isElementlessPage, pageHead } from '@/lib/pageBreaks';
import { measureOrClear } from './canvasGeometry';

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
  /**
   * この線で終わるページ(`page` ページ目)が要素の無い白紙のページか。その前の線と同じ位置に
   * 来るので 1 本にまとめてあり、ラベルで白紙のページを知らせる。白紙でなければ持たない。
   */
  blank?: boolean;
}

interface PageGuidesContext {
  editor: ShallowRef<Editor | undefined>;
  /** ページごとのパーツ(`useGrapes.ts` の `pageBlocks`。区切りの要素は含まない)。 */
  pageBlocks: ShallowRef<HTMLElement[][]>;
  /** 数えた区切りの要素(`splitPages` の `breakEls`。先頭・末尾・連続のものも含む)。 */
  breakEls: ShallowRef<HTMLElement[]>;
  /** 各区切りが置かれるページ(`splitPages` の `breakPages`。`breakEls` と同じ順)。 */
  breakPages: ShallowRef<number[]>;
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
   * guide 線を再計算する。ページ `i`(1 以上)の先頭の要素(パーツか区切り)の上端に 1 本ずつ
   * 引き、番号は `i`(「ここまで i ページ目」)。前のページにパーツがあり、その末尾のパーツの後ろに
   * 区切りの帯が描かれていれば、最初の帯の上端に引く(帯の下に線が来ると、帯と線が離れて見える
   * ため)。白紙のページ(区切りだけのページ)では帯を前後の線で挟む。要素の無い白紙のページ
   * (左右合わせで挟んだもの)の前後の線は同じ位置に来るので 1 本にまとめ、`blank` を付ける。
   * まとめた線は、直前の要素のあるページの末尾に帯があれば帯の上端、無ければ次の要素の上端に
   * 引く(白紙のページが続いても同じ)。高さ 0 の帯(テンプレの CSS で消えているなど)は描かれて
   * いないとみなす。位置は scroll/zoom のたびに測り直すが、ページの集合は content 変更時に
   * `useGrapes.ts` が数え直したものを使う。
   */
  function refreshPageGuides(): void {
    const ed = ctx.editor.value;
    const body = ed?.Canvas.getBody();
    if (!ed || !body) {
      pageGuides.value = [];
      return;
    }
    // 失敗(canvas の一時的な状態)は guide を静かに隠す。
    measureOrClear(
      () => {
        // `noScroll: true`: 既定の `getElementPos` は内部 `offset()` で iframe document の
        // scroll 量を足し戻し、戻り値が content 基準(scroll 非依存)になる。overlay guide は
        // 非スクロールの `<main>` 上に置くため、iframe スクロール時に追従させるには viewport
        // 相対が要る。GrapesJS 自身も tool 配置で同じ opts を使う(grapesjs canvas の
        // `CommandSelectComponent.getElementPos`)。`refreshRect` も同様。
        const pos = (el: HTMLElement) => ed.Canvas.getElementPos(el, { noScroll: true });
        const bodyPos = pos(body);
        const pages = ctx.pageBlocks.value;
        const breaks = ctx.breakEls.value;
        const breakPages = ctx.breakPages.value;
        const split = { pages, breakEls: breaks, breakPages };
        const out: PageGuide[] = [];
        /** ページ `page` の末尾のパーツ `last` の後ろにある、描かれた(高さのある)最初の帯の位置。 */
        const bandAfter = (last: HTMLElement, page: number) => {
          for (let j = 0; j < breaks.length; j++) {
            if (breakPages[j] !== page || !precedes(last, breaks[j])) continue;
            const p = pos(breaks[j]);
            if (p.height > 0) return p;
          }
          return undefined;
        };
        for (let i = 1; i < pages.length; i++) {
          // 要素の無い白紙のページ i の先頭の線は、次のページの線と同じ位置に来る。次の線へまとめる。
          if (isElementlessPage(split, i)) continue;
          // まとめた線は飛ばした線(続く白紙のページのうち最初のものの先頭)の位置を受け継ぐ。直前の
          // 要素のあるページの末尾に帯があれば、次の要素の上端ではなく帯の上端に引くため。
          let from = i;
          while (from >= 2 && isElementlessPage(split, from - 1)) from--;
          const prevLast = pages[from - 1].at(-1);
          const band = prevLast ? bandAfter(prevLast, from - 1) : undefined;
          // 末尾の改ページは消えるので、ページ i 以降には必ず要素がある。
          const head = pageHead(split, i) as HTMLElement;
          const guide: PageGuide = {
            top: band ? band.top : pos(head).top,
            left: bodyPos.left,
            width: bodyPos.width,
            page: i,
          };
          // 白紙のページをまとめた線(`from` が `i` より手前)は白紙の印を付ける。
          if (from < i) guide.blank = true;
          out.push(guide);
        }
        pageGuides.value = out;
      },
      () => {
        pageGuides.value = [];
      },
    );
    // guide と同じ scroll/zoom/content の契機でメモ目印も測り直す(位置追従)。
    ctx.afterGuides?.();
  }

  return { pageGuides, refreshPageGuides };
}
