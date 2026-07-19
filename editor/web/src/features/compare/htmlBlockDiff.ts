// =============================================================================
// htmlBlockDiff.ts — レンダリング済みテンプレ HTML のクライアント側 細粒度差分
// =============================================================================
// 役割: 2 つのレンダリング済みテンプレート HTML を決定的に diff する。版の比較
// (compare)の結果画面で使う。
//
// 2 版は `renderJinja` で完全な HTML へレンダリングし、ブラウザ内でパースする。
// 各ドキュメントを明示的な `page-break-before/after: always` マーカー
// (editor が `geom.ts` 経由で書き出すものと同一)で A4 の `page` に分割し、page 内では
// `<body>` 直下の子要素である top-level の `block` に整列する。
//
// 整列した block のうち中身が変わったものは、ブロック全体を塗るのではなく **ツリーを
// 再帰的に降りて**変わった部分だけを着色する(粒度を細かくするのが目的):
//   - ネストした要素は同じ安定キーで整列し、変わった子要素・追加/削除された子要素
//     だけを着色する。
//   - テキストは語句単位(英数字は単語、CJK は 1 文字)で LCS 差分を取り、挿入された
//     語句(緑)・削除された語句(赤)だけを `<span>` で包む。
// これにより「どの文字が変わったか」までハイライトでき、変更 block 数も数えられる。

import { rawKey } from '@/lib/blockKey';
import { defaultHtmlParser, type HtmlParser } from '@/lib/htmlParser';

export type BlockStatus = 'same' | 'changed' | 'added' | 'removed';

export interface DiffBlock {
  /** 2 版で同じ block を整列させるための安定キー。 */
  key: string;
  status: BlockStatus;
  /** このパーツだけの着色済み before マークアップ(added パーツでは空)。承認画面のパーツ行用。 */
  beforeHtml: string;
  /** このパーツだけの着色済み after マークアップ(removed パーツでは空)。 */
  afterHtml: string;
  /** 人間向けラベル「ページN・パーツM」(`partKey.ts` の `partLabelMap` と同採番)。 */
  label: string;
}

export interface DiffPage {
  index: number;
  changed: boolean;
  changedBlockCount: number;
  blocks: DiffBlock[];
  /** 前回ペイン用の page マークアップ。削除/変更箇所は既にハイライト済み。 */
  beforeHtml: string;
  /** 今回ペイン用の page マークアップ。追加/変更箇所は既にハイライト済み。 */
  afterHtml: string;
}

export interface HtmlDiff {
  pages: DiffPage[];
  changedPageCount: number;
  /** 比較元(before)を `page-break` で分割した総ページ数(アライン UI の選択範囲に使う)。 */
  beforePageCount: number;
  /** 比較先(after)を `page-break` で分割した総ページ数。 */
  afterPageCount: number;
}

/**
 * 比較元/比較先のどのページ同士を 1 枚として並べるかの対応付け。`null` はその側に
 * 対応ページが無い(= 反対側だけ存在 → 全 added / 全 removed)。`buildHtmlDiffAligned`
 * に渡すと、固定 i↔i ではなくユーザー指定のページずらしで diff できる。
 */
export interface PagePair {
  before: number | null;
  after: number | null;
}

// ── 1. ハイライト用クラス(スタイルは `iframe` 内で定義) ──────────────────────
// block 級(要素まるごと): 追加/削除された要素、または着色しきれない変更の保険。
export const HL_CHANGED = 'cmp-changed';
export const HL_ADDED = 'cmp-added';
export const HL_REMOVED = 'cmp-removed';
// 語句級(テキスト中の差分): 挿入語句(after ペイン)・削除語句(before ペイン)。
export const HL_INS = 'cmp-ins';
export const HL_DEL = 'cmp-del';

// 版比較(`CompareResultView`)と承認プレビュー(`ReviewDiffView`)が共有する、iframe 内の
// ハイライト CSS とドキュメント組み立て。着色ルール(`.cmp-*`)は両画面で同一で、body の
// padding だけ画面ごとに変えるため引数化する(二重管理を避ける)。
export function diffHighlightCss(bodyPadding: number): string {
  return `
  body{margin:0;padding:${bodyPadding}px;background:#fff;}
  .${HL_CHANGED}{background:rgba(220,38,38,.06)!important;box-shadow:inset 3px 0 0 #dc2626;}
  .${HL_ADDED}{background:rgba(22,163,74,.08)!important;box-shadow:inset 3px 0 0 #16a34a;}
  .${HL_REMOVED}{background:rgba(217,119,6,.08)!important;box-shadow:inset 3px 0 0 #d97706;}
  .${HL_INS}{background:rgba(22,163,74,.18);color:#15803d;text-decoration:underline;border-radius:2px;}
  .${HL_DEL}{background:rgba(220,38,38,.14);color:#b91c1c;text-decoration:underline;border-radius:2px;}
`;
}

/** 断片 HTML を、版ファンド CSS + ハイライト CSS 付きの完結した srcdoc ドキュメントに包む。 */
export function buildDiffDoc(fragment: string, css: string, highlightCss: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><style>${css}</style><style>${highlightCss}</style></head><body>${fragment}</body></html>`;
}

// ── 2. パースと page 分割 ─────────────────────────────────────────────────
// 注入された `parse`(メイン=DOMParser / Worker=linkedom)で body を取り出す。
function parseBody(html: string, parse: HtmlParser): HTMLElement {
  return parse(html).body;
}

function topLevelBlocks(body: HTMLElement): HTMLElement[] {
  return Array.from(body.children) as HTMLElement[];
}

/**
 * クラス由来の改ページを拾うための、CSS から抽出した page-break セレクタ。実テンプレは
 * `.page { page-break-after: always }` のように改ページを **CSS クラス**で表すため、
 * インライン `style` だけ見ると分割を取りこぼす(editor 側 `recomputeBreakEls` は
 * `getComputedStyle` で拾えている)。
 */
interface BreakSelectors {
  before: string[];
  after: string[];
}
const NO_BREAK_SELECTORS: BreakSelectors = { before: [], after: [] };

// 宣言ブロック内で `which` 方向の改ページを `always`/`page` に設定しているか。`auto`
// (例: `.page:last-child { page-break-after: auto }`)は改ページではないので拾わない。
function declHasBreak(decls: string, which: 'before' | 'after'): boolean {
  return (
    new RegExp(`page-break-${which}\\s*:\\s*(always|page)`).test(decls) ||
    new RegExp(`(^|[^-])break-${which}\\s*:\\s*(always|page)`).test(decls)
  );
}

/**
 * CSS テキストを走査し、改ページを設定しているルールの **セレクタ列**を方向別に集める。
 * `el.matches(selector)` で top-level block 側を判定するために使う。`@media` 等の
 * ネストブロックは扱わない簡易スキャンだが、テンプレの素朴な flat ルールには十分。
 */
function extractBreakSelectors(css: string | undefined): BreakSelectors {
  if (!css) return NO_BREAK_SELECTORS;
  const out: BreakSelectors = { before: [], after: [] };
  const lower = css.toLowerCase();
  for (const m of lower.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    const decls = m[2];
    if (declHasBreak(decls, 'before')) out.before.push(selector);
    if (declHasBreak(decls, 'after')) out.after.push(selector);
  }
  return out;
}

// 不正セレクタ(`:last-child` 等は有効だが、CSS には matches が解さない記法も混じり得る)で
// `el.matches` が throw しても分割判定を止めないようガードする。
function matchesAny(el: HTMLElement, selectors: string[]): boolean {
  for (const sel of selectors) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* ignore invalid selector */
    }
  }
  return false;
}

// インライン `style` 属性の改ページ、または CSS クラス由来の改ページセレクタへの一致。
function hasBreak(el: HTMLElement, which: 'before' | 'after', sels: BreakSelectors): boolean {
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  return (
    new RegExp(`page-break-${which}\\s*:\\s*always`).test(style) ||
    new RegExp(`(^|[^-])break-${which}\\s*:\\s*(always|page)`).test(style) ||
    matchesAny(el, sels[which])
  );
}

/** top-level の block を、明示的な page-break マーカーで page にグループ化する。 */
function paginate(blocks: HTMLElement[], sels: BreakSelectors): HTMLElement[][] {
  const pages: HTMLElement[][] = [[]];
  for (const el of blocks) {
    let cur = pages[pages.length - 1];
    if (hasBreak(el, 'before', sels) && cur.length > 0) {
      pages.push([]);
      cur = pages[pages.length - 1];
    }
    cur.push(el);
    if (hasBreak(el, 'after', sels)) pages.push([]);
  }
  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
  return pages;
}

// ── 3. ノードの整列キー ───────────────────────────────────────────────────
// Worker(linkedom)には `Node` グローバルが無いため、nodeType の仕様固定値を直接使う
// (ELEMENT_NODE=1, TEXT_NODE=3。browser/jsdom/linkedom で共通の DOM 仕様値)。
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
function isElement(n: Node): n is HTMLElement {
  return n.nodeType === ELEMENT_NODE;
}
function isText(n: Node): n is Text {
  return n.nodeType === TEXT_NODE;
}

// `rawKey`(要素の整列アンカー)は `@/lib/blockKey` へ集約し、editor のパーツ単位メモと
// 共有する(版を跨ぐパーツ対応づけが両者で同一ロジックになる)。

/** diff の対象にする子ノード: 要素ノードと、空白のみでないテキストノード。 */
function childUnits(parent: Node): Node[] {
  return Array.from(parent.childNodes).filter(
    (n) => isElement(n) || (isText(n) && (n.textContent ?? '').trim() !== ''),
  );
}

/** ノードの整列キー(要素は `rawKey`、テキストは `#text`)。 */
function unitKey(n: Node): string {
  return isElement(n) ? rawKey(n) : '#text';
}

/** 親の中で重複するキーを出現順で一意化する("#text#1", ".row#2")。 */
function keyedUnits(parent: Node): { key: string; node: Node }[] {
  const seen = new Map<string, number>();
  return childUnits(parent).map((node) => {
    const base = unitKey(node);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, node };
  });
}

// ── 4. 正規化と同一判定 ───────────────────────────────────────────────────
function collapse(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 2 ノードがマークアップ上同一か(要素は outerHTML、テキストは折り畳み比較)。
 * 要素はまず生 outerHTML の厳密一致を見て、一致した時点で空白正規化(`collapse`)を
 * 省く(同一ページ/同一ブロックが多数派なので、正規表現コストの節約が効く)。生が
 * 違う時だけ `collapse` で空白差を吸収して比較するため、判定結果は従来と不変。
 */
function sameMarkup(x: Node, y: Node): boolean {
  if (isElement(x) && isElement(y)) {
    const ox = x.outerHTML;
    const oy = y.outerHTML;
    return ox === oy || collapse(ox) === collapse(oy);
  }
  if (isText(x) && isText(y)) return collapse(x.textContent) === collapse(y.textContent);
  return false;
}

// ── 5. 語句単位のテキスト diff ────────────────────────────────────────────
// 英数字の連なりは 1 単語、CJK・記号・空白はそれぞれ 1 トークンに刻む。日本語は
// 文字単位、英語は単語単位という直感的な粒度になる。
export function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9]+|\s+|[^A-Za-z0-9\s]/gu) ?? [];
}

export type DiffOp = { type: 'same' | 'del' | 'ins'; text: string };

/** トリム後の中央部のみを LCS して順序付き編集列を作る(full DP 本体)。 */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..], b[j..] の最長共通部分列長。
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', text: a[i++] });
    } else {
      ops.push({ type: 'ins', text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'ins', text: b[j++] });
  return ops;
}

/**
 * 2 トークン列の順序付き編集列。共通する前置トークンを `same` として剥がし、残りだけ
 * full DP(`lcsDiff`)へ渡す。テキストは先頭が共通で以降だけ変わる場合が多く、DP テーブル
 * O(n*m) を縮められる。前置の貪欲 `same` と残りの DP は元の素朴 full DP と同一の op 列に
 * なる(前置共通の op は必ず `same`、残り DP は a[start..]/b[start..] の DP と一致するため)。
 * 後置(suffix)トリムは DP のタイブレーク `lcs[i+1][j] >= lcs[i][j+1]` と相互作用して稀に
 * op 列が変わる(`diffTokens` パリティテストで検出)ため採用しない。
 */
export function diffTokens(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === 0) return lcsDiff(a, b);
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'same', text: a[i] });
  ops.push(...lcsDiff(a.slice(start), b.slice(start)));
  return ops;
}

/** 片側ペインの再構成: 共通語句は素のテキスト、差分語句は `<span>` で着色して包む。 */
function sideNodes(ops: DiffOp[], doc: Document, side: 'before' | 'after'): Node[] {
  const markType = side === 'before' ? 'del' : 'ins';
  const cls = side === 'before' ? HL_DEL : HL_INS;
  const nodes: Node[] = [];
  let plain = '';
  let marked = '';
  const flushPlain = () => {
    if (plain) {
      nodes.push(doc.createTextNode(plain));
      plain = '';
    }
  };
  const flushMarked = () => {
    if (marked) {
      const span = doc.createElement('span');
      span.className = cls;
      span.textContent = marked;
      nodes.push(span);
      marked = '';
    }
  };
  for (const op of ops) {
    if (op.type === markType) {
      flushPlain();
      marked += op.text;
    } else if (op.type === 'same') {
      flushMarked();
      plain += op.text;
    }
    // 反対側だけの編集(before における ins 等)はこのペインには現れないので無視。
  }
  flushPlain();
  flushMarked();
  return nodes;
}

/** 対応するテキストノード対を語句 diff し、各ノードを着色済みノード列で置換する。 */
function inlineWordDiff(beforeText: Text, afterText: Text): void {
  const ops = diffTokens(
    tokenize(beforeText.textContent ?? ''),
    tokenize(afterText.textContent ?? ''),
  );
  const bDoc = beforeText.ownerDocument;
  const aDoc = afterText.ownerDocument;
  beforeText.replaceWith(...sideNodes(ops, bDoc, 'before'));
  afterText.replaceWith(...sideNodes(ops, aDoc, 'after'));
}

// ── 6. ノード木の再帰 diff(クローンを直接書き換える) ──────────────────────
function markWhole(node: Node, cls: string): void {
  if (isElement(node)) node.classList.add(cls);
  else if (isText(node) && node.textContent) {
    const span = node.ownerDocument.createElement('span');
    span.className = cls;
    span.textContent = node.textContent;
    node.replaceWith(span);
  }
}

/**
 * 同じキーで対応する 2 要素(同一 tag)の子を整列し、変わった部分だけを着色する。
 * 何かを着色できたら `true`、属性のみ差分などで降りても着色対象が無ければ `false`。
 * `before`/`after` はいずれも書き換え用クローン。
 */
function diffElement(before: HTMLElement, after: HTMLElement): boolean {
  const bUnits = keyedUnits(before);
  const aUnits = keyedUnits(after);
  const bMap = new Map(bUnits.map((u) => [u.key, u.node]));
  const aMap = new Map(aUnits.map((u) => [u.key, u.node]));
  // after の出現順を先に、続けて after に無い before のみのキーを並べる。
  const keys = [
    ...aUnits.map((u) => u.key),
    ...bUnits.filter((u) => !aMap.has(u.key)).map((u) => u.key),
  ];

  let marked = false;
  for (const key of keys) {
    const b = bMap.get(key);
    const a = aMap.get(key);
    if (a && b) {
      if (sameMarkup(a, b)) continue; // 完全一致の部分木はそのまま残す
      if (isText(a) && isText(b)) {
        inlineWordDiff(b, a);
        marked = true;
      } else if (isElement(a) && isElement(b) && a.tagName === b.tagName) {
        // 同 tag の要素対はさらに降りる。降りても何も着けられなければ保険で要素ごと。
        if (!diffElement(b, a)) {
          markWhole(b, HL_CHANGED);
          markWhole(a, HL_CHANGED);
        }
        marked = true;
      } else {
        // 同スロットだが種別/tag が違う → 削除+追加として扱う。
        markWhole(b, HL_REMOVED);
        markWhole(a, HL_ADDED);
        marked = true;
      }
    } else if (a) {
      markWhole(a, HL_ADDED);
      marked = true;
    } else if (b) {
      markWhole(b, HL_REMOVED);
      marked = true;
    }
  }
  return marked;
}

// ── 7. top-level block の整列と分類 ───────────────────────────────────────
function keyedBlocks(page: HTMLElement[]): { key: string; el: HTMLElement }[] {
  const seen = new Map<string, number>();
  return page.map((el) => {
    const base = rawKey(el);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, el };
  });
}

interface RenderedBlock {
  status: BlockStatus;
  /** before ペインに出すマークアップ(着色済み)。after のみの block では空。 */
  beforeHtml: string;
  /** after ペインに出すマークアップ(着色済み)。before のみの block では空。 */
  afterHtml: string;
}

/** 1 つの top-level block 対を分類し、両ペイン分の着色済みマークアップを作る。 */
function renderBlock(
  before: HTMLElement | undefined,
  after: HTMLElement | undefined,
): RenderedBlock {
  if (after && before) {
    if (sameMarkup(after, before)) {
      return { status: 'same', beforeHtml: before.outerHTML, afterHtml: after.outerHTML };
    }
    const bClone = before.cloneNode(true) as HTMLElement;
    const aClone = after.cloneNode(true) as HTMLElement;
    if (after.tagName === before.tagName) {
      if (!diffElement(bClone, aClone)) {
        bClone.classList.add(HL_CHANGED);
        aClone.classList.add(HL_CHANGED);
      }
    } else {
      bClone.classList.add(HL_CHANGED);
      aClone.classList.add(HL_CHANGED);
    }
    return { status: 'changed', beforeHtml: bClone.outerHTML, afterHtml: aClone.outerHTML };
  }
  if (after) {
    const clone = after.cloneNode(true) as HTMLElement;
    clone.classList.add(HL_ADDED);
    return { status: 'added', beforeHtml: '', afterHtml: clone.outerHTML };
  }
  // before のみ(after が undefined)。
  const clone = (before as HTMLElement).cloneNode(true) as HTMLElement;
  clone.classList.add(HL_REMOVED);
  return { status: 'removed', beforeHtml: clone.outerHTML, afterHtml: '' };
}

/** ページの top-level block を生 outerHTML で `'\n'` 連結する(高速パスの同一判定用)。 */
function joinOuter(page: HTMLElement[]): string {
  return page.map((el) => el.outerHTML).join('\n');
}

/**
 * before/after ページが生 outerHTML 連結で完全一致するなら、`diffPage`(再帰 diff +
 * `cloneNode` + LCS)を省いて `same` ページを直接返す。一致しなければ `null`。
 * 400p の比較でも実変更は数ページなので、無変更ページのスキップが最大の高速化になる。
 * 生一致時の `diffPage` の出力(全 block `same`、各ペインは `outerHTML` を `'\n'` 連結)と
 * バイト同一になるよう構築するため、出力は従来と不変。
 */
function fastSamePage(
  index: number,
  beforePage: HTMLElement[],
  afterPage: HTMLElement[],
): DiffPage | null {
  const beforeHtml = joinOuter(beforePage);
  const afterHtml = joinOuter(afterPage);
  if (beforeHtml.length !== afterHtml.length || beforeHtml !== afterHtml) return null;
  // 無変更ページなので各パーツの before/after は同一 outerHTML。承認画面の「変更なしも表示」用。
  const blocks: DiffBlock[] = keyedBlocks(afterPage).map((b, qi) => ({
    key: b.key,
    status: 'same',
    beforeHtml: b.el.outerHTML,
    afterHtml: b.el.outerHTML,
    label: `ページ${index + 1}・パーツ${qi + 1}`,
  }));
  return { index, changed: false, changedBlockCount: 0, blocks, beforeHtml, afterHtml };
}

function diffPage(index: number, beforePage: HTMLElement[], afterPage: HTMLElement[]): DiffPage {
  const before = keyedBlocks(beforePage);
  const after = keyedBlocks(afterPage);
  const beforeMap = new Map(before.map((b) => [b.key, b.el]));
  const afterMap = new Map(after.map((b) => [b.key, b.el]));

  const rendered = new Map<string, RenderedBlock>();
  const blocks: DiffBlock[] = [];
  // after の出現順を先に、続けて before のみの block を並べて分類する。
  const keys = [
    ...after.map((b) => b.key),
    ...before.filter((b) => !afterMap.has(b.key)).map((b) => b.key),
  ];
  // 「ページN・パーツM」採番(`partLabelMap` と同思想): after(現行)側 DOM 順を 1..N で優先し、
  // after に無い removed パーツは N+1 以降を before 側 DOM 順で振る。removed に before 側
  // index をそのまま使うと after 側の別パーツと同名になり、承認画面で削除対象を取り違える。
  const labelOf = new Map<string, string>();
  after.forEach((b, qi) => {
    labelOf.set(b.key, `ページ${index + 1}・パーツ${qi + 1}`);
  });
  let removedSeq = after.length;
  for (const b of before) {
    if (labelOf.has(b.key)) continue;
    removedSeq++;
    labelOf.set(b.key, `ページ${index + 1}・パーツ${removedSeq}`);
  }
  for (const key of keys) {
    const r = renderBlock(beforeMap.get(key), afterMap.get(key));
    rendered.set(key, r);
    blocks.push({
      key,
      status: r.status,
      beforeHtml: r.beforeHtml,
      afterHtml: r.afterHtml,
      label: labelOf.get(key) ?? `ページ${index + 1}`,
    });
  }

  const changedBlockCount = blocks.filter((b) => b.status !== 'same').length;
  return {
    index,
    changed: changedBlockCount > 0,
    changedBlockCount,
    blocks,
    // 各ペインは自分の版の block 並び順で組み立てる(削除/追加もその順で現れる)。
    beforeHtml: before.map((b) => rendered.get(b.key)?.beforeHtml ?? '').join('\n'),
    afterHtml: after.map((b) => rendered.get(b.key)?.afterHtml ?? '').join('\n'),
  };
}

/** HTML を `page-break`(インライン `style` + CSS クラス由来)で top-level page 群へ分割する。 */
function paginateDoc(html: string, css: string | undefined, parse: HtmlParser): HTMLElement[][] {
  return paginate(topLevelBlocks(parseBody(html, parse)), extractBreakSelectors(css));
}

/** ペア配列の各 page を diff する共通本体。`buildHtmlDiff`/`buildHtmlDiffAligned` の合流点。 */
function diffPairs(
  beforePages: HTMLElement[][],
  afterPages: HTMLElement[][],
  pairs: PagePair[],
): HtmlDiff {
  const pages: DiffPage[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { before, after } = pairs[i];
    const bp = before == null ? [] : (beforePages[before] ?? []);
    const ap = after == null ? [] : (afterPages[after] ?? []);
    // 無変更ページは高速パスでスキップ、変わったページのみ精密 diff に回す。
    pages.push(fastSamePage(i, bp, ap) ?? diffPage(i, bp, ap));
  }
  return {
    pages,
    changedPageCount: pages.filter((p) => p.changed).length,
    beforePageCount: beforePages.length,
    afterPageCount: afterPages.length,
  };
}

/**
 * 2 つのレンダリング済み HTML ドキュメント間の page/細粒度差分を構築する(固定 i↔i 対応)。
 * `cssBefore`/`cssAfter` を渡すと、`.page { page-break-after: always }` のような
 * CSS クラス由来の改ページも分割に反映する(省略時はインライン `style` のみで分割)。
 */
export function buildHtmlDiff(
  beforeHtml: string,
  afterHtml: string,
  cssBefore?: string,
  cssAfter?: string,
  parse: HtmlParser = defaultHtmlParser,
): HtmlDiff {
  const beforePages = paginateDoc(beforeHtml, cssBefore, parse);
  const afterPages = paginateDoc(afterHtml, cssAfter, parse);
  // 恒等 pairs(i↔i、範囲外側は null)で合流。出力は従来と不変。
  const pageCount = Math.max(beforePages.length, afterPages.length);
  const pairs: PagePair[] = Array.from({ length: pageCount }, (_, i) => ({
    before: i < beforePages.length ? i : null,
    after: i < afterPages.length ? i : null,
  }));
  return diffPairs(beforePages, afterPages, pairs);
}

/**
 * `buildHtmlDiff` の対応付けをユーザー指定の `pairs` で駆動する版。比較画面でページを
 * ずらして「指定ページ同士」を並べるのに使う。`pairs` の各要素が結果の 1 ページに対応し、
 * `before`/`after` がそのページに置くソースページ index(`null` は対応なし)。
 */
export function buildHtmlDiffAligned(
  beforeHtml: string,
  afterHtml: string,
  cssBefore: string | undefined,
  cssAfter: string | undefined,
  pairs: PagePair[],
  parse: HtmlParser = defaultHtmlParser,
): HtmlDiff {
  return diffPairs(
    paginateDoc(beforeHtml, cssBefore, parse),
    paginateDoc(afterHtml, cssAfter, parse),
    pairs,
  );
}
