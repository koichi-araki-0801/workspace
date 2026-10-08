// =============================================================================
// insertTarget.ts — 新しいパーツの挿入先と「このページに挿入できるか」(DOM を読むだけの純関数)
// =============================================================================
// 挿入先は現在ページの範囲の末尾。選んだパーツ(根の直下)がこのページにあればその直後、無ければ
// 次の区切りの直前(最後のページなら末尾)。「最後のパーツの直後」にしないのは、作成タブの本文は
// `{% if %}` などの範囲を根の直下の HTML コメント(範囲の印)で表し、最後のパーツの直後が閉じの印の
// 手前(枝の中)になるため。区切りの直前なら印の後ろに入る。
//
// 次の区切り(ページの境目)が固めた範囲の包み(`div.jinja-frozen-body`)の中にあるときは挿入できない。
// 包みの中身は保存で原文から作り直すので中に入れても消え、本文の末尾へ黙って入れると別のページに
// 落ちる。GrapesJS の component への反映は `useGrapes.ts` の `insertPart` が受け持つ。

import { pageHead } from '@/lib/pageBreaks';
import { splitRootPages } from './partKey';

/** 挿入先。`el` は根の直下の要素(その直後 / 直前に入れる)。 */
export type InsertTarget =
  | { kind: 'after'; el: HTMLElement }
  | { kind: 'before'; el: HTMLElement }
  | { kind: 'end' }
  | { kind: 'blocked' };

/** 挿入できないときの理由(左の区画の追加ボタンのツールチップ)。 */
export const INSERT_BLOCKED_MESSAGE =
  'このページの区切りが固めた範囲（{% if %} などの包み）の中にあるため、ここには挿入できません。' +
  '別のページを選んでください。';

/**
 * ページ `pageIndex` の範囲の末尾の挿入先。`selTop` は選んでいるパーツを含む根の直下の要素。
 *
 * 境目の要素(次のページの先頭か、数えた区切り)を、最後のパーツの後ろの兄弟から探す。最後の
 * パーツが包みの中なら、包みの中で見つからなければ包みの外へ出て探し続ける。境目が根の直下に
 * あればその直前、包みの中にある(または境目を抱えた包みに当たった)なら挿入できない、境目が
 * 無ければ末尾。
 *
 * 最後のパーツが inline の `break-after` を持つときは、次のページの先頭(区切りか次のパーツ)の
 * 直前に入る。新しいパーツは改ページの後ろなので次のページへ入るが、利用者の書いた改ページ
 * 指定は動かさない(挿入のために `style` を書き換えない)。
 */
export function insertTarget(
  root: HTMLElement,
  pageIndex: number,
  selTop?: HTMLElement,
): InsertTarget {
  const split = splitRootPages(root);
  const page = split.pages[pageIndex] ?? [];
  if (selTop && selTop.parentElement === root && page.includes(selTop)) {
    return { kind: 'after', el: selTop };
  }
  const beforeOrBlocked = (el: HTMLElement): InsertTarget =>
    el.parentElement === root ? { kind: 'before', el } : { kind: 'blocked' };
  const last = page.at(-1);
  if (!last) {
    // 白紙のページ: そのページの区切りの直前(要素の無い白紙のページなら次のページの先頭の直前)。
    const head = pageHead(split, pageIndex);
    return head ? beforeOrBlocked(head) : { kind: 'end' };
  }
  const next = pageHead(split, pageIndex + 1);
  const isBoundary = (el: Element) => el === next || split.breakEls.includes(el as HTMLElement);
  const holdsBoundary = (el: Element) =>
    (next !== undefined && el.contains(next)) || split.breakEls.some((b) => el.contains(b));
  for (let cur: Element = last; ; ) {
    for (let el = cur.nextElementSibling; el; el = el.nextElementSibling) {
      if (isBoundary(el)) return beforeOrBlocked(el as HTMLElement);
      if (holdsBoundary(el)) return { kind: 'blocked' };
    }
    const parent = cur.parentElement;
    // `parentElement` の型が null を含むので絞る。`cur` は `root` の子孫なので null にはならない。
    if (!parent || parent === root) return { kind: 'end' };
    cur = parent;
  }
}
