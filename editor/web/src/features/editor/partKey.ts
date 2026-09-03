// =============================================================================
// partKey.ts — 版を跨いで安定な「パーツ単位」構造キーの算出(メモ機能の紐付けキー)
// =============================================================================
// 役割: 編集 canvas のライブ DOM 上で、選択要素が属する「パーツ」(= `.page` 直下の
// top-level block)を版を跨いで一意に指す構造パスキーを作る。キーは `pageAnchor/partAnchor`
// で、各アンカーは `@/lib/blockKey` の `rawKey`(data-part-id→id→class→tag)+ 兄弟内の
// 出現順。HTML 構造のみに依存するため、版種/基準日が変わっても同じ構造のパーツなら一致する
// (版比較 `htmlBlockDiff.ts` のブロック整列と同思想)。コメントはこのキーでパーツを指す
// (スレッドは版インスタンス単位で、ペアや他版とは共有しない)。
//
// 限界: ページの追加/削除でページの並びがずれた場合や、catalog 由来でないパーツ(安定な
// `data-part-id` を持たない)では best-effort になる(compare の位置整列と同程度)。基準日
// 更新のように構造が同一な版替えでは確実に一致する。

import { occurrenceKey } from '@/lib/blockKey';
import { REDLINE_ATTR } from './redline/redlineApply';

/**
 * canvas root(GrapesJS wrapper か body)直下の `.page` 要素列。1 件も無ければ root 自身を
 * 1 ページ扱いにする(`pageView.ts` の `enumeratePageEls` と同方針の純粋 DOM 版)。
 * `useTemplateEditor.ts` の `selectPartByKey`(選択側の列挙)もこの関数を使う — キー計算
 * (`partPathKeyFor`)と選択側で列挙ロジックが分岐すると、両者が違うページを指してキーの
 * 対応がずれる。
 */
export function pageEls(root: HTMLElement): HTMLElement[] {
  const pages = Array.from(root.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('page'),
  );
  return pages.length > 0 ? pages : [root];
}

/**
 * page 直下の top-level block(= パーツ)列。要素ノードのみ。赤入れ表示が挿す削除要素
 * （`[data-redline]`。生 DOM だけに在りモデルには無い）は除く — 数えるとメモの構造キーと
 * 「ページN・パーツM」の採番が表示の ON/OFF で変わってしまう。
 */
export function partEls(pageEl: HTMLElement): HTMLElement[] {
  return Array.from(pageEl.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !el.hasAttribute(REDLINE_ATTR),
  );
}

/** 選択要素から、属する page とその直下のパーツ要素を解決する。 */
function resolvePart(
  el: HTMLElement,
  root: HTMLElement,
): { page: HTMLElement; part: HTMLElement } | null {
  const pages = pageEls(root);
  // `.page` 内の要素なら最も近い `.page` を、`.page` を持たない構成では root をページ扱い。
  const page = (el.closest('.page') as HTMLElement | null) ?? (pages[0] === root ? root : null);
  if (!page) return null;
  // page の直接の子(= パーツ)まで遡る。el が page 自身/外なら part = page。
  let part = el;
  while (part.parentElement && part.parentElement !== page) part = part.parentElement;
  if (part.parentElement !== page) part = page;
  return { page, part };
}

/**
 * page/part 要素から安定キー `pageAnchor/partAnchor` を組み立てる。`partPathKeyFor`(選択解決)と
 * `partLabelMap`(全列挙)でキー生成を共有し、両者のキーが必ず一致するようにする内部ヘルパ。
 */
function partKeyOf(
  page: HTMLElement,
  part: HTMLElement,
  pages: readonly HTMLElement[],
  root: HTMLElement,
): string {
  const pageKey = pages[0] === root ? 'body#1' : occurrenceKey(page, pages);
  const partKey = occurrenceKey(part, partEls(page));
  return `${pageKey}/${partKey}`;
}

/**
 * 選択要素の版を跨いで安定なパーツキー `pageAnchor/partAnchor` を返す。解決できなければ null。
 * 同一パーツ内のどの子要素を選んでも、囲う top-level block の同一キーに解決される
 * (= 紐付け単位は「パーツ」)。
 */
export function partPathKeyFor(el: HTMLElement, root: HTMLElement): string | null {
  const r = resolvePart(el, root);
  if (!r) return null;
  return partKeyOf(r.page, r.part, pageEls(root), root);
}

/**
 * canvas 全パーツの安定キー → 人間向けラベル `ページ{p}・パーツ{q}` のマップ。修正履歴を全パーツ
 * 横断で表示する際の行ラベルに使う(`Inspector.vue`)。`partKey` の `#n` は同種兄弟内の出現順で
 * 子の通し番号ではないため、ここで現 DOM を順に列挙して通し番号 `p`/`q` を採番する。キーは
 * `partPathKeyFor` と同じ `partKeyOf` で作るので、選択時に解決されるキーと必ず一致する。
 */
export function partLabelMap(root: HTMLElement): Map<string, string> {
  const map = new Map<string, string>();
  const pages = pageEls(root);
  pages.forEach((page, pi) => {
    partEls(page).forEach((part, qi) => {
      map.set(partKeyOf(page, part, pages, root), `ページ${pi + 1}・パーツ${qi + 1}`);
    });
  });
  return map;
}
