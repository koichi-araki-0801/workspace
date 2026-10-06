// =============================================================================
// partKey.ts — 版を跨いで安定な「パーツ単位」構造キーの算出(メモ機能の紐付けキー)
// =============================================================================
// 役割: 内容の根(canvas では GrapesJS の wrapper、静的な文書では body)の直下の要素(固めた範囲の
// 包みは中身へ展開する)から、区切り(`div.pagebreak`)と数えない要素(`@/lib/pageBreaks` の
// `pageItems`)を除いたものを「パーツ」とし、選択要素が属するパーツを版を跨いで一意に指すキーを
// 作る。キーは文書全体での `<アンカー>#<通し番号>`(`@/lib/blockKey` の `rawKey`(data-part-id→id
// →class→tag)+ 全パーツの中での同アンカーの出現順)で、ページを含まない。ページの追加・削除でキーがずれないように
// するため。HTML 構造のみに依存するため、版種/基準日が変わっても同じ構造のパーツなら一致する
// (版比較 `htmlBlockDiff.ts` の `DiffBlock.partKey` と同じキー)。コメントはこのキーでパーツを
// 指す(スレッドは版インスタンス単位で、ペアや他版とは共有しない)。`id` は既定で DOM の `id` を
// 読むが、canvas のライブ要素は GrapesJS が自動 `id` を付けて回るため、canvas 側の呼び出しは
// `canvasRawKey` をアンカー関数として渡し、モデルの明示属性から `id` を読み替える。
//
// 限界: 同じアンカーのパーツを前に足す・消すと、後ろの同じアンカーのパーツの番号がずれる。
// catalog 由来でないパーツ(安定な `data-part-id` を持たない)では best-effort になる(compare の
// 位置整列と同程度)。基準日更新のように構造が同一な版替えでは確実に一致する。

import type { Editor } from 'grapesjs';
import { type RawKeyOf, rawKey, rawKeyFromParts } from '@/lib/blockKey';
import { pageItems, splitPages } from '@/lib/pageBreaks';

/**
 * 根の直下のパーツをページごとに分けたもの(`splitPages` の結果。区切りの要素は含まない)。
 * 必ず 1 ページ以上。キーの計算(`partPathKeyFor`)と選択側(`useTemplateEditor.ts` の
 * `selectPartByKey`)が同じ列挙を使う — 分岐すると両者が違うパーツを指してキーの対応がずれる。
 */
export function pagesOf(root: HTMLElement): HTMLElement[][] {
  const children = Array.from(root.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
  return splitPages(pageItems(children)).pages;
}

/** 文書全体のパーツ(ページ順)。 */
export function partsOf(root: HTMLElement): HTMLElement[] {
  return pagesOf(root).flat();
}

/**
 * `el` を含む根の直下のパーツ。区切り自身、数えない要素(`<style>`・赤入れの削除要素など)と
 * その中、根そのもの、根の外は null。
 */
export function partOf(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  const parts = partsOf(root);
  const i = partIndex(el, root, parts);
  return i < 0 ? null : parts[i];
}

/**
 * `el` を含むパーツの `parts` の中の位置。パーツでなければ -1。パーツは根の直下か、固めた範囲の
 * 包みの直下(`@/lib/pageBreaks` の `rootBlocks`)にあるので、根へ向かって最初に当たるパーツを採る。
 */
function partIndex(el: HTMLElement, root: HTMLElement, parts: readonly HTMLElement[]): number {
  if (!root.contains(el)) return -1;
  for (let cur: HTMLElement | null = el; cur && cur !== root; cur = cur.parentElement) {
    const i = parts.indexOf(cur);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 全パーツのキー(`parts` と同じ並び)。`occurrenceKey(part, 全パーツ, keyOf)` と同じ値を、出現順の
 * 数え上げ 1 回で作る(パーツごとに全パーツを走査すると二乗になる)。
 */
function partKeys(parts: readonly HTMLElement[], keyOf: RawKeyOf): string[] {
  const seen = new Map<string, number>();
  return parts.map((part) => {
    const base = keyOf(part);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}

/**
 * 選択要素の版を跨いで安定なパーツキー `<アンカー>#<通し番号>` を返す。解決できなければ null。
 * 同一パーツ内のどの子要素を選んでも、囲うパーツの同一キーに解決される(= 紐付け単位は「パーツ」)。
 */
export function partPathKeyFor(
  el: HTMLElement,
  root: HTMLElement,
  keyOf: RawKeyOf = rawKey,
): string | null {
  const parts = partsOf(root);
  const i = partIndex(el, root, parts);
  return i < 0 ? null : partKeys(parts, keyOf)[i];
}

/** パーツ 1 つの、キー・ページ番号(0 始まり)・ページの中の番号(0 始まり)。 */
export interface PartEntry {
  part: HTMLElement;
  key: string;
  page: number;
  index: number;
}

/**
 * 全パーツ(ページ順)とそのキー・ページ番号。キーは `partPathKeyFor` と同じ値で、全パーツを
 * 1 回だけ数えて作る。全パーツを回す側(canvas の目印・キーからの選択)は、パーツごとに
 * `partPathKeyFor` を呼ぶと二乗になるので、これを使う。
 */
export function partEntries(root: HTMLElement, keyOf: RawKeyOf = rawKey): PartEntry[] {
  const pages = pagesOf(root);
  const keys = partKeys(pages.flat(), keyOf);
  const out: PartEntry[] = [];
  pages.forEach((page, pi) => {
    page.forEach((part, qi) => {
      out.push({ part, key: keys[out.length], page: pi, index: qi });
    });
  });
  return out;
}

/** 各パーツについて、キー・ページ番号(0 始まり)・ページの中の番号(0 始まり)を順に呼ぶ。 */
function eachPart(
  root: HTMLElement,
  keyOf: RawKeyOf,
  fn: (key: string, page: number, index: number) => void,
): void {
  for (const e of partEntries(root, keyOf)) fn(e.key, e.page, e.index);
}

/**
 * 全パーツの安定キー → 人間向けラベル `ページ{p}・パーツ{q}` のマップ。修正履歴を全パーツ
 * 横断で表示する際の行ラベルに使う(`Inspector.vue`)。キーの `#n` は同じアンカーの出現順で
 * パーツの通し番号ではないため、ページは `splitPages` の番号、パーツはそのページの中の番号を
 * ここで振る。キーは `partPathKeyFor` と同じ規則で作るので、選択時に解決されるキーと必ず一致する。
 */
export function partLabelMap(root: HTMLElement, keyOf: RawKeyOf = rawKey): Map<string, string> {
  const map = new Map<string, string>();
  eachPart(root, keyOf, (key, pi, qi) => map.set(key, `ページ${pi + 1}・パーツ${qi + 1}`));
  return map;
}

/**
 * 全パーツの安定キー → そのパーツが属するページの index(0 始まり)。承認画面のコメント一覧が
 * 「行クリックで見た目比較の該当ページへ送る」ために使う。キーの作り方は `partLabelMap` と同じ
 * なので、両者のキー集合は必ず一致する。
 */
export function partPageIndexMap(root: HTMLElement, keyOf: RawKeyOf = rawKey): Map<string, number> {
  const map = new Map<string, number>();
  eachPart(root, keyOf, (key, pi) => map.set(key, pi));
  return map;
}

/**
 * 旧形式(`ページ/パーツ`。ページを含んだキー)のキーの数。旧形式のメモ・修正履歴はどのパーツにも
 * 当たらないので、移行はせずに件数を編集画面の警告に出す。今のキーは `/` を含まない。
 */
export function legacyPartKeyCount(keys: Iterable<string>): number {
  let n = 0;
  for (const key of keys) if (key.includes('/')) n += 1;
  return n;
}

/**
 * 編集 canvas 用のアンカー関数。GrapesJS はライブ要素すべてに自動 `id`(ccid)を付けるが、
 * それは `getHtml()` に残らず、確定版 HTML を静的に読む側(承認タブ・compare)のキーには
 * 現れない。canvas 側だけ DOM の `id` を信じるとテンプレートに `data-part-id` も明示 `id` も
 * 無いパーツ宛のコメントが他所で一つも引けなくなるため、`id` はモデルの明示属性から取る
 * (モデルの `attributes` には明示属性しか無い。`redline/redlineTree.ts` と同じ前提)。
 * 要素 → component は `Components.getById`(`selectPartByKey` と同じ経路)で解決する。
 */
export function canvasRawKey(ed: Editor): RawKeyOf {
  return (el) => {
    const comp = el.id ? ed.Components.getById(el.id) : undefined;
    const attrs = comp?.get('attributes') as Record<string, unknown> | undefined;
    return rawKeyFromParts({
      partId: el.getAttribute('data-part-id'),
      id: typeof attrs?.id === 'string' ? attrs.id : null,
      firstClass: el.classList[0] ?? null,
      tag: el.tagName,
    });
  };
}
