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
// アンカーの属性の原文に Jinja があると、承認タブとキーが一致しない(`jinjaAnchoredParts` で
// 警告する)。

import type { Editor } from 'grapesjs';
import { type RawKeyOf, rawKey, rawKeyFromParts } from '@/lib/blockKey';
import {
  b64decodeUtf8,
  DATA_OPAQUE,
  DATA_OPAQUE_KIND,
  FROZEN_BODY_CLASS,
  JINJA_CHIP_CLASS,
} from '@/lib/jinjaAttrs';
import { type PageSplit, pageItems, splitPages } from '@/lib/pageBreaks';

/**
 * 根の直下の要素をページに分ける。canvas のページ(`useGrapes.ts`)・パーツのキー・キーからの
 * 選択が同じ分け方を使う — 分岐するとページとパーツの番号・キーの対応がずれる。根の直下の SVG・
 * MathML の要素も、静的な文書(承認タブ・比較は `body.children` を数える)と同じくパーツに数える。
 * 読むのは `Element` の API だけなので、型は `HTMLElement` にそろえる。
 */
export function splitRootPages(root: HTMLElement): PageSplit<HTMLElement> {
  return splitPages(pageItems(Array.from(root.children) as HTMLElement[]));
}

/**
 * 根の直下のパーツをページごとに分けたもの(`splitRootPages` の `pages`。区切りの要素は含まない)。
 * 必ず 1 ページ以上。
 */
export function pagesOf(root: HTMLElement): HTMLElement[][] {
  return splitRootPages(root).pages;
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
export function partPathKeyFor(el: HTMLElement, root: HTMLElement, keyOf: RawKeyOf): string | null {
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
 * 当たらないので、移行はせずに件数を編集画面の警告に出す。今のキーのアンカーもクラス名
 * (`.w-1/2` など)や `id` から `/` を含みうるので、`/` を含むだけでなく今のパーツのキー
 * (`current`)に無いものだけを数える。
 */
export function legacyPartKeyCount(
  keys: Iterable<string>,
  current: { has(key: string): boolean },
): number {
  let n = 0;
  for (const key of keys) if (key.includes('/') && !current.has(key)) n += 1;
  return n;
}

/**
 * base64 の原文を読み、最初の要素を返す。原文が要素で始まらない(`{% raw %}`・TeX)・読めないときは
 * null。`template` の中身は文書に属さないので、`<script>` は実行されず資源も取りに行かない。
 */
function parseSourceElement(el: HTMLElement, encoded: string | null): Element | null {
  if (!encoded) return null;
  let source: string;
  try {
    source = b64decodeUtf8(encoded);
  } catch {
    return null;
  }
  if (!/^<[a-z]/i.test(source)) return null;
  const t = el.ownerDocument.createElement('template');
  t.innerHTML = source;
  // `<math>` は HTMLElement でないが、`rawKey` が読むのは属性・クラス・タグ名だけ。
  return t.content.firstElementChild;
}

/**
 * 原文を運ぶチップ(`<script>`・`<math>`・`<textarea>` など)が運ぶ要素。canvas ではチップの
 * `span` に化けているが、承認タブ・比較が読む描画後の文書では原文の要素そのものなので、アンカーは
 * 原文の要素から取る(チップの `.jinja-chip` で取ると、根の直下のチップのパーツだけ画面ごとに
 * キーが割れる)。
 */
function chipSourceElement(el: HTMLElement): Element | null {
  if (!el.classList.contains(JINJA_CHIP_CLASS)) return null;
  return parseSourceElement(el, el.getAttribute(DATA_OPAQUE));
}

/**
 * 固めた要素(`data-opaque-kind="frozen"`)が運ぶ原文の要素。canvas は属性値まで値を入れて描くので、
 * アンカーの原文は運んでいる原文から読む(警告用。キーの計算は変えない)。固めた表は
 * `div.jinja-frozen-body` の包みが原文を運び、表自身は運ばない。包みの子がそのパーツ 1 つだけの
 * ときは包みの原文がそのパーツの原文なので、包みから読む。
 */
function frozenSourceElement(el: HTMLElement): Element | null {
  const carrier = frozenCarrier(el);
  return carrier ? parseSourceElement(carrier, carrier.getAttribute(DATA_OPAQUE)) : null;
}

function frozenCarrier(el: HTMLElement): HTMLElement | null {
  if (el.getAttribute(DATA_OPAQUE_KIND) === 'frozen') return el;
  const parent = el.parentElement;
  if (
    parent?.classList.contains(FROZEN_BODY_CLASS) &&
    parent.getAttribute(DATA_OPAQUE_KIND) === 'frozen' &&
    parent.childElementCount === 1
  ) {
    return parent;
  }
  return null;
}

/** GrapesJS が canvas の DOM へ付ける状態クラスの接頭辞(既定の `stylePrefix`)。 */
const GJS_CLASS_PREFIX = 'gjs-';

/**
 * 編集 canvas 用のアンカー関数。GrapesJS はライブ要素すべてに自動 `id`(ccid)を付けるが、
 * それは `getHtml()` に残らず、確定版 HTML を静的に読む側(承認タブ・compare)のキーには
 * 現れない。canvas 側だけ DOM の `id` を信じるとテンプレートに `data-part-id` も明示 `id` も
 * 無いパーツ宛のコメントが他所で一つも引けなくなるため、`id` はモデルの明示属性から取る
 * (モデルの `attributes` には明示属性しか無い。`redline/redlineTree.ts` と同じ前提)。
 * クラスもモデルから取る(保存 HTML に出るのはモデルのクラス)。GrapesJS は選択中・ホバー中の
 * 要素の DOM へだけ `gjs-selected` / `gjs-hovered` などの状態クラスを足すため、DOM の先頭クラスを読むと、自前の
 * クラスを持たないパーツは選択・ホバーの間だけ別のキーになり、メモの目印や一覧の行から
 * 引けなくなる。component を引けない要素は、状態クラスの接頭辞 `gjs-` を DOM から除いて読む。
 * 要素 → component は `Components.getById`(`selectPartByKey` と同じ経路)で解決する。
 */
export function canvasRawKey(ed: Editor): RawKeyOf {
  return (el) => {
    const carried = chipSourceElement(el);
    if (carried) return rawKey(carried as HTMLElement);
    const comp = el.id ? ed.Components.getById(el.id) : undefined;
    const attrs = comp?.get('attributes') as Record<string, unknown> | undefined;
    const firstClass = comp
      ? comp.getClasses()[0]
      : Array.from(el.classList).find((c) => !c.startsWith(GJS_CLASS_PREFIX));
    return rawKeyFromParts({
      partId: el.getAttribute('data-part-id'),
      id: typeof attrs?.id === 'string' ? attrs.id : null,
      firstClass: firstClass ?? null,
      tag: el.tagName,
    });
  };
}

/** Jinja の区切りの開き(`{{` `{%` `{#`)。 */
const JINJA_OPEN_RE = /\{[{%#]/;

/**
 * 根の直下のパーツのうち、キーに採用されるアンカーの属性(`data-part-id` → `id` → class)の原文に
 * Jinja を含むもの。canvas は原文で、承認タブ・比較はファンドの値で描いた後の文書でアンカーを
 * 読むので、キーが原理的に一致しない(そのパーツのメモが承認タブで別のパーツ扱いになる)。警告用。
 * 採用の順は `keyOf`(canvas では `canvasRawKey`)と同じ。固めた要素は表示用の値で描かれているので
 * 原文で見る。
 */
export function jinjaAnchoredParts(root: HTMLElement, keyOf: RawKeyOf): HTMLElement[] {
  return partsOf(root).filter((part) => {
    const source = frozenSourceElement(part);
    // 固めた要素は、canvas の自動 `id` と無関係な原文の明示属性を読むので、`keyOf` ではなく
    // `rawKey` を使う。`rawKey` が読むのは属性・クラス・タグ名だけなので、原文が `<math>` などで
    // `HTMLElement` でなくても読める。
    return JINJA_OPEN_RE.test(source ? rawKey(source as HTMLElement) : keyOf(part));
  });
}
