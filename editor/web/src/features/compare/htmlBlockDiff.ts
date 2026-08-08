// =============================================================================
// htmlBlockDiff.ts — レンダリング済みテンプレ HTML のクライアント側 細粒度差分
// =============================================================================
// 役割: 2 つのレンダリング済みテンプレート HTML を決定的に diff する。版の比較
// (compare)の結果画面で使う。
//
// 2 版は隔離 iframe(`lib/renderHostClient.ts`)で完全な HTML へレンダリングしたものを
// 受け取り、ブラウザ内でパースする。ここが触るのは**描画済み文字列**だけで、テンプレ式の
// 評価は行わない(だから同一オリジンの inert document で読んでよい)。
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
import { styleTag } from '@/lib/sanitizeCss';

export type BlockStatus = 'same' | 'changed' | 'added' | 'removed';

interface DiffBlock {
  /** 2 版で同じ block を整列させるための安定キー。 */
  key: string;
  status: BlockStatus;
  /** このパーツだけの着色済み before マークアップ(added パーツでは空)。承認画面のパーツ行用。 */
  beforeHtml: string;
  /** このパーツだけの着色済み after マークアップ(removed パーツでは空)。 */
  afterHtml: string;
  /** 人間向けラベル「ページN・パーツM」(`partKey.ts` の `partLabelMap` と同採番)。 */
  label: string;
  /** 語句単位 LCS を面積上限で打ち切り、全文 del+ins の粗い差分へ落ちたパーツか。 */
  coarse: boolean;
}

export interface DiffPage {
  index: number;
  changed: boolean;
  changedBlockCount: number;
  blocks: DiffBlock[];
  /** このページに粗い差分へ落ちたパーツが 1 つでもあるか(画面の簡易表示注記用)。 */
  coarse: boolean;
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
  /** どこか 1 ページでも粗い差分へ落ちたか(画面全体の注記を出すかの判断に使う)。 */
  coarse: boolean;
  /**
   * 資源上限で**承認者に見せられなかった領域があるか**。`coarse`(粒度を落とした)と違い、
   * こちらは領域そのものが差分に現れない。確定書込は本文を全文書くので、承認者が見ていない
   * 内容が本番へ入りうる — 画面は必ずこの旨を出すこと(再スキャン F9)。
   */
  truncated: boolean;
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
// 語句級のうち、面積上限で語句 LCS を諦めた「全文まるごと」の塊に併記する印。
export const HL_COARSE = 'cmp-coarse';

// 版比較(`CompareResultView`)と承認プレビュー(`ReviewDiffView`)が共有する、iframe 内の
// ハイライト CSS とドキュメント組み立て。着色ルール(`.cmp-*`)は両画面で同一で、body の
// padding だけ画面ごとに変えるため引数化する(二重管理を避ける)。
/**
 * 装飾はすべて `!important` で書く — `buildDiffDoc` のカスケードレイヤによる守りは
 * **重要宣言でしか優先順位が逆転しない**ため、通常宣言のままだと申請者 CSS に負ける。
 *
 * `visibility` は入れるが **`display` は入れない**。`display:block!important` を足すと
 * `<td class="cmp-changed">` のような正当なマークアップの表レイアウトを壊す
 * (守りが本体を壊す形)。したがって申請者が `display:none` で変更箇所ごと隠す余地は残る —
 * これは装飾の優先度では閉じられないので、承認画面の注記(印刷時のみ効く規則がある旨)と
 * PDF プレビューでの確認で受ける。
 */
export function diffHighlightCss(bodyPadding: number): string {
  return `
  body{margin:0;padding:${bodyPadding}px;background:#fff;}
  .${HL_CHANGED}{background:rgba(220,38,38,.06)!important;box-shadow:inset 3px 0 0 #dc2626!important;visibility:visible!important;}
  .${HL_ADDED}{background:rgba(22,163,74,.08)!important;box-shadow:inset 3px 0 0 #16a34a!important;visibility:visible!important;}
  .${HL_REMOVED}{background:rgba(217,119,6,.08)!important;box-shadow:inset 3px 0 0 #d97706!important;visibility:visible!important;}
  .${HL_INS}{background:rgba(22,163,74,.18)!important;color:#15803d!important;text-decoration:underline!important;border-radius:2px;visibility:visible!important;}
  .${HL_DEL}{background:rgba(220,38,38,.14)!important;color:#b91c1c!important;text-decoration:underline!important;border-radius:2px;visibility:visible!important;}
  .${HL_COARSE}{outline:1px dashed currentColor!important;outline-offset:1px;}
`;
}

/**
 * 着色済みマークアップが粗いフォールバック(`HL_COARSE`)を含むか。承認画面は `DiffBlock` を
 * presentation 用の行(`ReviewPartRow`)へ写す際にフラグ列を落とすため、表示側は着色結果の
 * 字面から判定する(比較画面は `DiffPage.coarse` を直接使える)。本文テキストに同じ字面が
 * 含まれると誤検知しうるが、出るのは注記 1 行だけなので実害はない。
 */
export function hasCoarseDiff(...htmls: string[]): boolean {
  return htmls.some(
    (h) => h.includes(`${HL_DEL} ${HL_COARSE}`) || h.includes(`${HL_INS} ${HL_COARSE}`),
  );
}

/**
 * 差分装飾を置く CSS カスケードレイヤの名前を 1 文書ぶん作る。**推測不能**であることが要件。
 *
 * 申請者は自分の CSS に任意のレイヤを書けるので、名前が既知だと
 * `@layer diff { html body .cmp-ins { background:none !important } }` のように**同じレイヤへ
 * 相乗りして**より高い詳細度で上書きできてしまう(同一レイヤ・同一重要度の中では詳細度と
 * ソース順で決まり、レイヤの守りが働かない)。名前を知られなければこの経路が消える。
 */
function diffLayerName(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return `d${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 断片 HTML を、版ファンド CSS + ハイライト CSS 付きの完結した srcdoc ドキュメントに包む。
 * `css` は他ユーザが書いたテンプレ由来なので `<style>` の脱出を潰してから埋める。
 *
 * `fragment` 側の能動コンテンツは**除去しない**(テンプレの JS は正当なコンテンツで、
 * 承認者は実行結果を見て承認する)。隔離は表示先 iframe の `sandbox="allow-scripts"`
 * (same-origin なし)が担う。ここで潰すのは「`</style>` で CSS 文脈を抜けて親の srcdoc
 * 構造そのものを書き換える」形だけで、これは sandbox の内側でも成立してしまう
 * (ハイライト表示を偽装して差分を隠せる)ため別途必要である。
 *
 * ── 差分装飾を申請者 CSS から守る(再スキャン F8)──
 * `</style>` 脱出を潰しても、**通常のカスケード**で差分の視覚表現は消せた。申請者 CSS の
 * `.cmp-ins{background:none!important}` が宣言順で勝ち、承認者のペインから着色と左帯が
 * 消えてしまう(= 変更箇所が無いように見える)。
 *
 * 解は CSS カスケードレイヤの**重要宣言では優先順位が逆転する**性質:
 *  - 通常宣言 … 後のレイヤが勝つ / 非レイヤ が レイヤ より強い
 *  - **重要宣言 … 先のレイヤが勝つ / 非レイヤ が 最弱**
 * よって差分装飾を「最初に宣言したレイヤ」に置き `!important` を付ければ、申請者が
 * `!important` を書いても(レイヤ内・レイヤ外どちらでも)上書きできない。
 *
 * 順序が要件そのものなので、レイヤ宣言だけを**申請者 CSS より前**の `<style>` で行う。
 * 後ろに置くと申請者が自分の CSS の先頭で宣言したレイヤの方が先になり、逆転が向こうへ効く。
 * 名前は `diffLayerName` で毎回変える(同名レイヤへの相乗りを塞ぐ)。
 */
export function buildDiffDoc(fragment: string, css: string, highlightCss: string): string {
  const layer = diffLayerName();
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><style>@layer ${layer};</style>${styleTag(css)}${styleTag(`@layer ${layer}{${highlightCss}}`)}</head><body>${fragment}</body></html>`;
}

// ── 2. パースと page 分割 ─────────────────────────────────────────────────
// 注入された `parse`(メイン=DOMParser / Worker=linkedom)で body を取り出す。
function parseBody(html: string, parse: HtmlParser): HTMLElement {
  return parse(html).body;
}

/**
 * ページ分割で走査する直下要素の数。実テンプレの直下要素はページ数オーダー(400 ページ級
 * でも数千)なので 5,000 で十分な余裕がある。超過分は畳んで捨てる — 分類 B(degrade)に
 * 従い例外にはしない。承認者が「差分を見られない」状態を作らないのが最優先。
 */
export const MAX_TOP_LEVEL_BLOCKS = 5_000;

function topLevelBlocks(body: HTMLElement): { blocks: HTMLElement[]; truncated: boolean } {
  const children = Array.from(body.children) as HTMLElement[];
  // 打ち切ったことは**必ず戻り値で申告する**。捨てた分は差分にもページにも現れないのに、
  // 承認が通れば確定書込は本文を全文書く — 承認者が見ていない領域が本番へ入る。
  // 語句 LCS の degrade(`coarse`)が常に表へ出るのと同じ扱いに揃える(再スキャン F9)。
  return children.length > MAX_TOP_LEVEL_BLOCKS
    ? { blocks: children.slice(0, MAX_TOP_LEVEL_BLOCKS), truncated: true }
    : { blocks: children, truncated: false };
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
 * `el.matches(selector)` で top-level block 側を判定するために使う。
 *
 * 正規表現 `/([^{}]+)\{([^{}]*)\}/g` は波括弧を含まない入力に対して開始位置ごとに末尾まで
 * 舐め直す二次で、実測 160KB = 13 秒・800KB で 5 分超だった。**カーソル単調前進**の走査へ
 * 置き換える — 前進は `indexOf` か 1 文字進みだけで、決して戻さない(戻す実装を書いた
 * 瞬間に二次が復活する)。閉じない `{` は入力末尾で打ち切る(例外にしない)。
 *
 * `@media` / `@supports` / `@layer` / `@container` は**条件付きグループ規則**で中身は通常の
 * スタイル規則なので、深さを 1 段下げて同じループで収集する。旧実装(二次の正規表現
 * `/([^{}]+)\{([^{}]*)\}/g`)は `@media print { .p { page-break-after: always } }` に対し
 * `['.p', …]` を返していたので、読み飛ばすと承認画面のページ分割が変わる(= 差分の
 * ページ対応が変わる)。`@page` / `@font-face` / `@keyframes` は中身が宣言かマージン
 * ボックスなので従来どおりブロックごと飛ばす。
 */
const CONDITIONAL_GROUP_AT_RULES = ['@media', '@supports', '@layer', '@container'];

function extractBreakSelectors(css: string | undefined): BreakSelectors {
  if (!css) return NO_BREAK_SELECTORS;
  const out: BreakSelectors = { before: [], after: [] };
  const lower = css.toLowerCase();
  const n = lower.length;
  let i = 0;
  while (i < n) {
    const open = lower.indexOf('{', i);
    if (open < 0) break;
    // グループ規則の閉じ `}` を跨いだ位置から読み始めることがあるので、prelude は最後の
    // `}` より後ろだけを採る(旧実装の `[^{}]+` と同じ範囲になる)。
    const rawPrelude = lower.slice(i, open);
    const afterBrace = rawPrelude.lastIndexOf('}');
    const prelude = (afterBrace < 0 ? rawPrelude : rawPrelude.slice(afterBrace + 1)).trim();
    const close = lower.indexOf('}', open + 1);
    if (close < 0) break;
    const nested = lower.indexOf('{', open + 1);
    if (prelude.startsWith('@') && nested >= 0 && nested < close) {
      if (CONDITIONAL_GROUP_AT_RULES.some((at) => prelude.startsWith(at))) {
        // 中身は通常のスタイル規則。カーソルをブロックの内側へ進めるだけ(単調前進は保つ)。
        i = open + 1;
        continue;
      }
      // それ以外の入れ子 at-rule はブロックごと飛ばす。
      let depth = 1;
      let p = open + 1;
      while (p < n && depth > 0) {
        const nextOpen = lower.indexOf('{', p);
        const nextClose = lower.indexOf('}', p);
        if (nextClose < 0) break;
        if (nextOpen >= 0 && nextOpen < nextClose) {
          depth++;
          p = nextOpen + 1;
        } else {
          depth--;
          p = nextClose + 1;
        }
      }
      i = p > open ? p : n;
      continue;
    }
    if (prelude && !prelude.startsWith('@')) {
      const decls = lower.slice(open + 1, close);
      if (declHasBreak(decls, 'before')) out.before.push(prelude);
      if (declHasBreak(decls, 'after')) out.after.push(prelude);
    }
    i = close + 1;
  }
  return out;
}

/**
 * `el.matches()` に回すセレクタ本数の上限。照合コストは「直下要素数 x セレクタ数」で、
 * linkedom は呼び出しごとにセレクタをコンパイルする(1 コール 1〜2.5 マイクロ秒)ため
 * B=S=20,000 で 500〜2,000 秒規模になる。単純セレクタ(`.cls` / `#id` / `tag`)は集合
 * 照合へ落とすので上限を消費せず、実テンプレがこの上限に当たることはまずない。
 */
export const MAX_COMPLEX_SELECTORS = 32;

/** 事前に単純セレクタを集合へ落としたもの。残りだけ `el.matches()` に回す。 */
interface CompiledBreaks {
  classes: Set<string>;
  ids: Set<string>;
  tags: Set<string>;
  complex: string[];
  /** 複合セレクタが上限を超えて切り捨てられたか(UI へ出すための degrade 印)。 */
  truncated: boolean;
}

/** 単純セレクタ = クラス / ID / タグ 1 つだけ。これらは集合照合で O(1) に落とせる。 */
const SIMPLE_SELECTOR_RE = /^(?:\.([a-z0-9_-]+)|#([a-z0-9_-]+)|([a-z][a-z0-9]*))$/;

function compileBreaks(selectors: string[]): CompiledBreaks {
  const compiled: CompiledBreaks = {
    classes: new Set(),
    ids: new Set(),
    tags: new Set(),
    complex: [],
    truncated: false,
  };
  for (const raw of selectors) {
    // `.a, .b` のようなセレクタ列は個々に分けてから単純判定する。
    for (const sel of raw.split(',')) {
      const one = sel.trim();
      if (!one) continue;
      const m = SIMPLE_SELECTOR_RE.exec(one);
      if (m?.[1]) compiled.classes.add(m[1]);
      else if (m?.[2]) compiled.ids.add(m[2]);
      else if (m?.[3]) compiled.tags.add(m[3]);
      else if (compiled.complex.length < MAX_COMPLEX_SELECTORS) compiled.complex.push(one);
      else compiled.truncated = true;
    }
  }
  return compiled;
}

// 不正セレクタ(`:last-child` 等は有効だが、CSS には matches が解さない記法も混じり得る)で
// `el.matches` が throw しても分割判定を止めないようガードする。
function matchesAny(el: HTMLElement, breaks: CompiledBreaks): boolean {
  if (breaks.tags.has(el.tagName.toLowerCase())) return true;
  if (el.id && breaks.ids.has(el.id.toLowerCase())) return true;
  if (breaks.classes.size > 0) {
    for (const cls of el.classList) {
      if (breaks.classes.has(cls.toLowerCase())) return true;
    }
  }
  for (const sel of breaks.complex) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      /* ignore invalid selector */
    }
  }
  return false;
}

/** 方向別にコンパイル済みのセレクタ。`paginate` の呼び出し 1 回につき 1 度だけ作る。 */
interface CompiledBreakSelectors {
  before: CompiledBreaks;
  after: CompiledBreaks;
}

function compileBreakSelectors(sels: BreakSelectors): CompiledBreakSelectors {
  return { before: compileBreaks(sels.before), after: compileBreaks(sels.after) };
}

// インライン `style` 属性の改ページ、または CSS クラス由来の改ページセレクタへの一致。
function hasBreak(
  el: HTMLElement,
  which: 'before' | 'after',
  sels: CompiledBreakSelectors,
): boolean {
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  return (
    new RegExp(`page-break-${which}\\s*:\\s*always`).test(style) ||
    new RegExp(`(^|[^-])break-${which}\\s*:\\s*(always|page)`).test(style) ||
    matchesAny(el, sels[which])
  );
}

/** top-level の block を、明示的な page-break マーカーで page にグループ化する。 */
function paginate(
  blocks: HTMLElement[],
  rawSels: BreakSelectors,
): { pages: HTMLElement[][]; truncated: boolean } {
  // セレクタのコンパイルは要素ごとではなく 1 回だけ(ここが B x S の S を潰す点)。
  const sels = compileBreakSelectors(rawSels);
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
  return { pages, truncated: sels.before.truncated || sels.after.truncated };
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

/** 語句 diff の結果。`coarse` は面積上限で語句単位を諦めたかどうか。 */
export interface TokenDiff {
  ops: DiffOp[];
  coarse: boolean;
}

/**
 * 語句 LCS の DP セル数 `n * m` の上限。テキストノードの中身は他ユーザ(申請者)が書いた
 * 本文で、`tokenize` は CJK を 1 文字 1 トークンに刻むため、巨大な段落を 1 つ置くだけで
 * `(n+1) x (m+1)` の密行列が数 GB になり承認者のタブごと落とせる。上限を超えたら
 * 語句着色を諦めて粗い差分に落とす(差分表示自体は必ず出す)。
 *
 * 4,000,000 は「実運用の本文は通れる」と「最悪でも数十 MB で止まる」の両立点。1 セルは
 * V8 の double 要素で 8 バイトなので約 32MB + 行配列のオーバーヘッドに収まり、片側
 * 2,000 トークン(日本語で約 2,000 字)同士までは従来どおり語句単位で着色できる。運用中の
 * 帳票テキストノードはページ内の 1 段落単位でこれを大きく下回る。
 */
export const MAX_LCS_CELLS = 4_000_000;

/**
 * 片側 1 辺のトークン数上限。積 `n * m` だけを見ると n=4,000,000 / m=1 のような偏った形が
 * 通り、`Array.from({length: n+1}, () => new Array(m+1))` が 400 万個の小配列を作る
 * (セル数から見積もる 32MB より 1 桁重い)。辺そのものにも上限を置いて潰す。
 */
export const MAX_LCS_DIM = 20_000;

/**
 * 1 回の diff 構築(= 1 文書ペア)で消費してよい DP セル総数。`MAX_LCS_CELLS` は
 * テキストノード 1 個ぶんの上限でしかなく、上限直下のノードを並べるだけで総量は
 * 「ノード数 x 400 万」と青天井になる(片側 2MB の HTML で分オーダー。ドラフト保存の
 * 8MB 上限に収まる)。予算を使い切った以降のノードは無条件に粗い差分へ落とす。
 */
export const MAX_LCS_TOTAL_CELLS = 40_000_000;

/** 文書 1 ペアぶんの DP セル予算。`buildHtmlDiff` の呼び出し 1 回ごとに作り直す。 */
export interface LcsBudget {
  remaining: number;
}

/** 予算を新規に確保する。 */
export function createLcsBudget(): LcsBudget {
  return { remaining: MAX_LCS_TOTAL_CELLS };
}

/**
 * 語句単位を諦めた粗い編集列: 片側全文の削除 + 反対側全文の挿入という 1 対に潰す。
 * 面積が上限を超えるのは両側とも非空のときだけ(片側が 0 なら `n * m` も 0)なので、
 * 空チェックは置かない。
 */
function coarseOps(a: string[], b: string[]): DiffOp[] {
  return [
    { type: 'del', text: a.join('') },
    { type: 'ins', text: b.join('') },
  ];
}

/** トリム後の中央部のみを LCS して順序付き編集列を作る(full DP 本体)。 */
function lcsDiff(a: string[], b: string[], budget?: LcsBudget): TokenDiff {
  const n = a.length;
  const m = b.length;
  // 行列を確保する前に面積を見る。ここが唯一の割り当て点なので、上限判定もここへ置く。
  const cells = n * m;
  if (cells > MAX_LCS_CELLS || n > MAX_LCS_DIM || m > MAX_LCS_DIM) {
    return { ops: coarseOps(a, b), coarse: true };
  }
  // 文書全体の予算。使い切った後も個々のノードは上限内なので、判定は per-node 上限とは別に置く。
  if (budget) {
    if (cells > budget.remaining) return { ops: coarseOps(a, b), coarse: true };
    budget.remaining -= cells;
  }
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
  return { ops, coarse: false };
}

/**
 * 2 トークン列の順序付き編集列。共通する前置トークンを `same` として剥がし、残りだけ
 * full DP(`lcsDiff`)へ渡す。テキストは先頭が共通で以降だけ変わる場合が多く、DP テーブル
 * O(n*m) を縮められる。前置の貪欲 `same` と残りの DP は元の素朴 full DP と同一の op 列に
 * なる(前置共通の op は必ず `same`、残り DP は a[start..]/b[start..] の DP と一致するため)。
 * 後置(suffix)トリムは DP のタイブレーク `lcs[i+1][j] >= lcs[i][j+1]` と相互作用して稀に
 * op 列が変わる(`diffTokens` パリティテストで検出)ため採用しない。
 *
 * 面積上限(`MAX_LCS_CELLS`)の判定は prefix トリム後の残りに対して効く。トリム自体は
 * O(min(n,m)) で行列を作らないため、末尾だけ変えた長文はトリムで小さくなり従来どおり
 * 語句単位で着色できる(粗い差分に落ちるのは残りが本当に巨大な場合だけ)。
 */
export function diffTokens(a: string[], b: string[], budget?: LcsBudget): TokenDiff {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === 0) return lcsDiff(a, b, budget);
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'same', text: a[i] });
  const rest = lcsDiff(a.slice(start), b.slice(start), budget);
  ops.push(...rest.ops);
  return { ops, coarse: rest.coarse };
}

/**
 * 片側ペインの再構成: 共通語句は素のテキスト、差分語句は `<span>` で着色して包む。
 * `coarse` の時は着色クラスに `HL_COARSE` を併記し、「語句単位ではなく全文の塊」である
 * ことを iframe 内の見た目(破線枠)と `hasCoarseDiff` の両方へ伝える。
 */
function sideNodes(
  ops: DiffOp[],
  doc: Document,
  side: 'before' | 'after',
  coarse: boolean,
): Node[] {
  const markType = side === 'before' ? 'del' : 'ins';
  const base = side === 'before' ? HL_DEL : HL_INS;
  const cls = coarse ? `${base} ${HL_COARSE}` : base;
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

/**
 * 対応するテキストノード対を語句 diff し、各ノードを着色済みノード列で置換する。
 * 粗い差分へ落ちたら `flags` に記録し、パーツ/ページ単位の注記まで持ち上げる。
 */
function inlineWordDiff(beforeText: Text, afterText: Text, flags: DiffFlags): void {
  const { ops, coarse } = diffTokens(
    tokenize(beforeText.textContent ?? ''),
    tokenize(afterText.textContent ?? ''),
    flags.budget,
  );
  if (coarse) flags.coarse = true;
  const bDoc = beforeText.ownerDocument;
  const aDoc = afterText.ownerDocument;
  beforeText.replaceWith(...sideNodes(ops, bDoc, 'before', coarse));
  afterText.replaceWith(...sideNodes(ops, aDoc, 'after', coarse));
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
 * 再帰 diff の途中で起きた「粗い差分へのフォールバック」を親へ返すための可変フラグ。
 * `diffElement` の戻り値(着色できたか)とは別の関心事なので、木を降りる間だけ共有する。
 */
interface DiffFlags {
  coarse: boolean;
  /** 文書 1 ペアで共有する DP セル予算(`diffPairs` が確保して木の末端まで持ち回る)。 */
  budget: LcsBudget;
}

/**
 * 同じキーで対応する 2 要素(同一 tag)の子を整列し、変わった部分だけを着色する。
 * 何かを着色できたら `true`、属性のみ差分などで降りても着色対象が無ければ `false`。
 * `before`/`after` はいずれも書き換え用クローン。
 */
function diffElement(before: HTMLElement, after: HTMLElement, flags: DiffFlags): boolean {
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
        inlineWordDiff(b, a, flags);
        marked = true;
      } else if (isElement(a) && isElement(b) && a.tagName === b.tagName) {
        // 同 tag の要素対はさらに降りる。降りても何も着けられなければ保険で要素ごと。
        if (!diffElement(b, a, flags)) {
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
  /** このパーツの中で語句 LCS が面積上限に当たり、粗い差分へ落ちたか。 */
  coarse: boolean;
}

/** 1 つの top-level block 対を分類し、両ペイン分の着色済みマークアップを作る。 */
function renderBlock(
  before: HTMLElement | undefined,
  after: HTMLElement | undefined,
  budget: LcsBudget,
): RenderedBlock {
  if (after && before) {
    if (sameMarkup(after, before)) {
      return {
        status: 'same',
        beforeHtml: before.outerHTML,
        afterHtml: after.outerHTML,
        coarse: false,
      };
    }
    const bClone = before.cloneNode(true) as HTMLElement;
    const aClone = after.cloneNode(true) as HTMLElement;
    const flags: DiffFlags = { coarse: false, budget };
    if (after.tagName === before.tagName) {
      if (!diffElement(bClone, aClone, flags)) {
        bClone.classList.add(HL_CHANGED);
        aClone.classList.add(HL_CHANGED);
      }
    } else {
      bClone.classList.add(HL_CHANGED);
      aClone.classList.add(HL_CHANGED);
    }
    return {
      status: 'changed',
      beforeHtml: bClone.outerHTML,
      afterHtml: aClone.outerHTML,
      coarse: flags.coarse,
    };
  }
  if (after) {
    const clone = after.cloneNode(true) as HTMLElement;
    clone.classList.add(HL_ADDED);
    return { status: 'added', beforeHtml: '', afterHtml: clone.outerHTML, coarse: false };
  }
  // before のみ(after が undefined)。
  const clone = (before as HTMLElement).cloneNode(true) as HTMLElement;
  clone.classList.add(HL_REMOVED);
  return { status: 'removed', beforeHtml: clone.outerHTML, afterHtml: '', coarse: false };
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
    coarse: false,
  }));
  return {
    index,
    changed: false,
    changedBlockCount: 0,
    blocks,
    beforeHtml,
    afterHtml,
    coarse: false,
  };
}

function diffPage(
  index: number,
  beforePage: HTMLElement[],
  afterPage: HTMLElement[],
  budget: LcsBudget,
): DiffPage {
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
    const r = renderBlock(beforeMap.get(key), afterMap.get(key), budget);
    rendered.set(key, r);
    blocks.push({
      key,
      status: r.status,
      beforeHtml: r.beforeHtml,
      afterHtml: r.afterHtml,
      label: labelOf.get(key) ?? `ページ${index + 1}`,
      coarse: r.coarse,
    });
  }

  const changedBlockCount = blocks.filter((b) => b.status !== 'same').length;
  return {
    index,
    changed: changedBlockCount > 0,
    changedBlockCount,
    blocks,
    coarse: blocks.some((b) => b.coarse),
    // 各ペインは自分の版の block 並び順で組み立てる(削除/追加もその順で現れる)。
    beforeHtml: before.map((b) => rendered.get(b.key)?.beforeHtml ?? '').join('\n'),
    afterHtml: after.map((b) => rendered.get(b.key)?.afterHtml ?? '').join('\n'),
  };
}

/** HTML を `page-break`(インライン `style` + CSS クラス由来)で top-level page 群へ分割する。 */
function paginateDoc(
  html: string,
  css: string | undefined,
  parse: HtmlParser,
): { pages: HTMLElement[][]; truncated: boolean } {
  const top = topLevelBlocks(parseBody(html, parse));
  const paged = paginate(top.blocks, extractBreakSelectors(css));
  return { pages: paged.pages, truncated: top.truncated || paged.truncated };
}

/** ペア配列の各 page を diff する共通本体。`buildHtmlDiff`/`buildHtmlDiffAligned` の合流点。 */
function diffPairs(
  beforePages: HTMLElement[][],
  afterPages: HTMLElement[][],
  pairs: PagePair[],
  truncated: boolean,
): HtmlDiff {
  const pages: DiffPage[] = [];
  // DP セル予算は文書ペア単位。ページごとに作り直すと「上限直下のページを並べる」形で
  // 総計算量が青天井に戻るため、必ずここで 1 つだけ確保して全ページで使い切る。
  const budget = createLcsBudget();
  for (let i = 0; i < pairs.length; i++) {
    const { before, after } = pairs[i];
    const bp = before == null ? [] : (beforePages[before] ?? []);
    const ap = after == null ? [] : (afterPages[after] ?? []);
    // 無変更ページは高速パスでスキップ、変わったページのみ精密 diff に回す。
    pages.push(fastSamePage(i, bp, ap) ?? diffPage(i, bp, ap, budget));
  }
  return {
    pages,
    changedPageCount: pages.filter((p) => p.changed).length,
    beforePageCount: beforePages.length,
    afterPageCount: afterPages.length,
    coarse: pages.some((p) => p.coarse),
    truncated,
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
  const before = paginateDoc(beforeHtml, cssBefore, parse);
  const after = paginateDoc(afterHtml, cssAfter, parse);
  // 恒等 pairs(i↔i、範囲外側は null)で合流。出力は従来と不変。
  const pageCount = Math.max(before.pages.length, after.pages.length);
  const pairs: PagePair[] = Array.from({ length: pageCount }, (_, i) => ({
    before: i < before.pages.length ? i : null,
    after: i < after.pages.length ? i : null,
  }));
  return diffPairs(before.pages, after.pages, pairs, before.truncated || after.truncated);
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
  const before = paginateDoc(beforeHtml, cssBefore, parse);
  const after = paginateDoc(afterHtml, cssAfter, parse);
  return diffPairs(before.pages, after.pages, pairs, before.truncated || after.truncated);
}
