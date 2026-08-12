// =============================================================================
// usePageGuides.ts — ページ境界 guide の算出
// =============================================================================
// 役割: canvas document から page break 要素を拾って cache し(`recomputeBreakEls`)、
// scroll/zoom 時はその cache を再測位して guide 線の座標列を出す(`refreshPageGuides`)。
// break キーワード判定は `pageView.ts` の `isBreakValue`(純粋関数・単体テスト済み)。

import { toAppError } from '@editor/shared';
import type { Editor } from 'grapesjs';
import { ref, type ShallowRef } from 'vue';
import { logError } from '@/lib/appError';
import { isBreakValue } from './pageView';

/**
 * A4 sheet 上に描く 1 本のページ境界 guide(canvas 相対 / zoom 考慮の座標、
 * `SelectedRect` と同様)。実際の page break(`break-*` / `page-break-*`、class 由来の
 * `.page` を含む)= 論理ページブロックの末尾だけを表す。改ページ判定は page break のみで
 * 行い、297mm の高さ推定(estimate)は描かない(`refreshPageGuides` を見よ)。
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
  /** guide と同じ scroll/zoom/content の契機で連動再計測するフック(メモ目印)。 */
  afterGuides?: () => void;
}

export function usePageGuides(ctx: PageGuidesContext) {
  /** ページ境界の overlay guide 群(`refreshPageGuides` を見よ)。 */
  const pageGuides = ref<PageGuide[]>([]);
  /**
   * `recomputeBreakEls` が cache する page-break 要素。画面上の位置は scroll/zoom
   * ごとに `refreshPageGuides` が読み直す。
   */
  let breakEls: { el: HTMLElement; edge: 'before' | 'after' }[] = [];

  /**
   * canvas document を走査し、印刷ページの開始/終了となる要素を `break-before/after`
   * や旧来の `page-break-*` から拾う。class 由来のルール(例
   * `.page { page-break-after: always }`)も含むが、それらは computed style にしか
   * 現れない(inline 専用の `geom.ts` の `geomFromStyle` は取りこぼす)。全ノードの
   * computed style を読むため重い。よって content/style 変更時のみ走らせ、
   * `refreshPageGuides` は scroll/zoom 時に cache 済み集合を再利用する。
   */
  function recomputeBreakEls(): void {
    const ed = ctx.editor.value;
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
   * 連続スクロールの canvas(`page-break-*` は画面レイアウトに効かない)の上に、
   * ページ境界 guide 線を再計算する。改ページ判定は実際の page break のみで行う:
   *
   * - cache 済みの各 break(`.page` 末尾、`break-*` / `page-break-*`)を hard break =
   *   論理ページの末尾とみなし、その位置に guide を 1 本引く。
   * - guide は出現順に累積ページ番号を付ける(「ここまで N ページ目」)。
   *
   * 高さ 297mm 由来の estimate(推定改ページ)は描かない。厳密な改ページは
   * Vivliostyle preview の役目であり、ここは page break 位置の可視化に徹する。
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
      const bodyPos = ed.Canvas.getElementPos(body, { noScroll: true });
      const top0 = bodyPos.top;
      const bottom = bodyPos.top + bodyPos.height;

      // hard break(論理ページ末尾)を昇順に並べ、端ぎりぎりのものは捨てる。
      const hard = breakEls
        .map(({ el, edge }) => {
          const p = ed.Canvas.getElementPos(el, { noScroll: true });
          return edge === 'before' ? p.top : p.top + p.height;
        })
        .filter((t) => t > top0 + 1 && t < bottom - 1)
        .sort((a, b) => a - b);

      // 各 hard break に guide を 1 本ずつ。番号は出現順の累積ページ。
      pageGuides.value = hard.map((top, i) => ({
        top,
        left: bodyPos.left,
        width: bodyPos.width,
        page: i + 1,
      }));
    } catch (e) {
      // 幾何の再計算に失敗(canvas の一時的な状態) — guide を静かに隠す。
      logError(toAppError(e));
      pageGuides.value = [];
    }
    // guide と同じ scroll/zoom/content の契機でメモ目印も測り直す(位置追従)。
    ctx.afterGuides?.();
  }

  return { pageGuides, recomputeBreakEls, refreshPageGuides };
}
