// =============================================================================
// htmlBlockDiff.ts — レンダリング済みテンプレ HTML のクライアント側 細粒度差分
// =============================================================================
// 役割: 2 つのレンダリング済みテンプレート HTML を決定的に diff する。版の比較
// (compare)の結果画面で使う。
//
// 2 版は隔離 iframe(`lib/renderHostClient.ts`)で完全な HTML へレンダリングしたものを
// 受け取り、ブラウザ内でパースする。ここが触るのは**描画済み文字列**だけで、テンプレ式の
// 評価は行わない(だから同一オリジンの inert document で読んでよい)。
// 各ドキュメントを `<body>` 直下の `<div class="pagebreak">` と、直下の要素の inline の改ページ
// 指定で `page` に分割し(判定は `lib/pageBreaks.ts` の `splitPages`。canvas・承認タブと共有)、
// page 内では `<body>` 直下の子要素である top-level の `block`(区切りの要素は除く)に整列する。
//
// 整列した block のうち中身が変わったものは、ブロック全体を塗るのではなく **ツリーを
// 再帰的に降りて**変わった部分だけを着色する(粒度を細かくするのが目的):
//   - ネストした要素は同じ安定キーで整列し、変わった子要素・追加/削除された子要素
//     だけを着色する。
//   - テキストは語句単位(英数字は単語、CJK は 1 文字)で LCS 差分を取り、挿入された
//     語句(緑)・削除された語句(赤)だけを `<span>` で包む。
// これにより「どの文字が変わったか」までハイライトでき、変更 block 数も数えられる。

import { occurrenceKeys, rawKey } from '@/lib/blockKey';
import { defaultHtmlParser, type HtmlParser } from '@/lib/htmlParser';
import { inlineBreak, pageItems, splitPages } from '@/lib/pageBreaks';
import { styleTag } from '@/lib/sanitizeCss';

export type BlockStatus = 'same' | 'changed' | 'added' | 'removed';

interface DiffBlock {
  /** 2 版で同じ block を整列させるための安定キー(ページの中での `<アンカー>#<出現順>`)。 */
  key: string;
  /**
   * メモ・修正履歴と同じパーツのキー(文書全体での `<アンカー>#<通し番号>`)。after 側に
   * ある block は after の文書、removed の block は before の文書で数える。整列には使わない
   * (ページの外のずれを整列へ持ち込まないため、整列は `key` で行う)。
   */
  partKey: string;
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
  /** 比較元(before)を改ページで分割した総ページ数(アライン UI の選択範囲に使う)。 */
  beforePageCount: number;
  /** 比較先(after)を改ページで分割した総ページ数。 */
  afterPageCount: number;
  /** どこか 1 ページでも粗い差分へ落ちたか(画面全体の注記を出すかの判断に使う)。 */
  coarse: boolean;
  /**
   * 資源上限で**承認者に見せられなかった領域があるか**。`coarse`(粒度を落とした)と違い、
   * こちらは領域そのものが差分に現れない。確定書込は本文を全文書くので、承認者が見ていない
   * 内容が本番へ入りうる — 画面は必ずこの旨を出すこと。
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

// 版比較(`CompareResultView`)と承認プレビュー(`ReviewDetail`)が共有する、iframe 内の
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
 * ── 差分装飾を申請者 CSS から守る ──
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

/**
 * 申請者 CSS に「**印刷時にだけ効く**規則」が含まれるか。承認画面へ注記を出すのに使う。
 *
 * なぜ要るか: 承認者が見る差分ペインは screen メディアだが、成果物(PDF)は print メディアで
 * 組まれる。`.x{display:none}` + `@media print{.x{display:block}}` と書けば「承認者には
 * 見えず PDF にだけ出る」内容を作れる。装飾の優先度(`buildDiffDoc` のカスケードレイヤ)は
 * これを閉じられない — 隠されているのはこちらの装飾ではなく**本文**だからである。
 *
 * 判定は**正規表現ではなく CSSOM** で行う。CSS はエスケープを許すので
 * `@\6d edia print` のような字面を正規表現は取りこぼすが、実ブラウザのパーサは同じ規則として
 * 解く(Chromium で `CSSMediaRule:print` になることを実測済み。同じ理由で
 * `shared/src/security/cssExternalRefs.ts` もトークナイザで判定している)。
 * 入れ子のグループ規則(`@supports` / `@layer` の中の `@media`)まで降りる。
 *
 * これは**注記であって関門ではない**。取りこぼしても承認は止まらず、承認者は PDF
 * プレビュー(vivliostyle = print 相当)で実際の見えを確認できる。
 */
export function hasPrintOnlyRules(css: string): boolean {
  if (!css.trim()) return false;
  // `media="not all"` を付けて**この文書には一切適用させず**、規則の解析結果だけを読む。
  // 切り離した document(`createHTMLDocument`)では stylesheet が結び付かず `sheet` が
  // null になるため、生きた document へ一時的に挿す以外に CSSOM を得る手が無い。
  const el = document.createElement('style');
  el.media = 'not all';
  el.textContent = css;
  document.head.appendChild(el);
  try {
    return el.sheet ? printOnlyInRules(el.sheet.cssRules) : false;
  } finally {
    el.remove();
  }
}

/** メディアクエリが「print には効くが screen には効かない」= 承認者の見えと乖離するか。 */
function divergesFromScreen(mediaText: string): boolean {
  const t = mediaText.toLowerCase();
  if (!/\bprint\b/.test(t)) return false;
  // `screen, print` や `all` は承認者の画面にも効くので乖離しない。
  return !/\bscreen\b/.test(t) && !/\ball\b/.test(t);
}

function printOnlyInRules(rules: CSSRuleList): boolean {
  for (const rule of Array.from(rules)) {
    const media = (rule as CSSMediaRule).media?.mediaText;
    if (media !== undefined && divergesFromScreen(media)) return true;
    // `@supports` / `@layer` の内側にも `@media` は書ける。
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested && printOnlyInRules(nested)) return true;
  }
  return false;
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

interface TopLevel {
  /** body 直下の要素と、地の文を包んだ合成 `span` を文書順に並べたもの。 */
  blocks: HTMLElement[];
  /** `blocks` のうち地の文を包んだ合成 `span`(改ページの判定とパーツのキーから外す)。 */
  texts: Set<HTMLElement>;
  truncated: boolean;
}

function topLevelBlocks(body: HTMLElement): TopLevel {
  // `body.children`(要素のみ)ではなく `body.childNodes` を走る。**要素だけを内容とみなす**と、
  // `<body>` 直下の地の文(テキストノード)がどのパーツにも現れず、打ち切り警告も立たないまま
  // 確定書込へ verbatim で通る(承認者が見ていない可視本文の承認)。ノード種を数え上げず、
  // 「内容を持つ子はすべてパーツ」で拾う: 非空テキストノードは合成 `span` で包み、以降の
  // 要素ベースのパイプライン(整列・着色・差分・textContent)へ載せる(包みは差分表示上の
  // 見た目だけで、確定される本文=`review.html` は変わらない)。空白のみのノードは従来どおり無視。
  const doc = body.ownerDocument;
  const all: HTMLElement[] = [];
  const texts = new Set<HTMLElement>();
  for (const node of Array.from(body.childNodes)) {
    if (isElement(node)) {
      all.push(node);
    } else if (isText(node) && (node.textContent ?? '').trim() !== '') {
      const span = doc.createElement('span');
      span.textContent = node.textContent;
      all.push(span);
      texts.add(span);
    }
  }
  // 打ち切ったことは**必ず戻り値で申告する**。捨てた分は差分にもページにも現れないのに、
  // 承認が通れば確定書込は本文を全文書く — 承認者が見ていない領域が本番へ入る。
  // 語句 LCS の degrade(`coarse`)が常に表へ出るのと同じ扱いに揃える。
  return all.length > MAX_TOP_LEVEL_BLOCKS
    ? { blocks: all.slice(0, MAX_TOP_LEVEL_BLOCKS), texts, truncated: true }
    : { blocks: all, texts, truncated: false };
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
  const units = childUnits(parent);
  const keys = occurrenceKeys(units.map(unitKey));
  return units.map((node, i) => ({ key: keys[i], node }));
}

// ── 4. 正規化と同一判定 ───────────────────────────────────────────────────
/** 空白の違いだけを差分にしない正規化(連続する空白を 1 つにして前後を落とす)。 */
export function collapse(text: string | null | undefined): string {
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
interface TokenDiff {
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
  const keys = occurrenceKeys(page.map(rawKey));
  return page.map((el, i) => ({ key: keys[i], el }));
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
  parts: PartIndex,
): DiffPage | null {
  const beforeHtml = joinOuter(beforePage);
  const afterHtml = joinOuter(afterPage);
  if (beforeHtml.length !== afterHtml.length || beforeHtml !== afterHtml) return null;
  // 無変更ページなので各パーツの before/after は同一 outerHTML。承認画面の「変更なしも表示」用。
  const keyed = keyedBlocks(afterPage);
  const labelOf = partLabels(index, keyed, [], parts);
  const blocks: DiffBlock[] = keyed.map((b) => ({
    key: b.key,
    partKey: parts.keys.get(b.el) ?? b.key,
    status: 'same',
    beforeHtml: b.el.outerHTML,
    afterHtml: b.el.outerHTML,
    label: labelOf.get(b.key) ?? `ページ${index + 1}`,
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

/**
 * 「ページN・パーツM」の採番(`partLabelMap` と同じ数え方): after(現行)側の DOM 順を 1..N で
 * 優先し、after に無い removed パーツは N+1 以降を before 側の DOM 順で振る。removed に before
 * 側の index をそのまま使うと after 側の別パーツと同名になり、承認画面で削除対象を取り違える。
 * パーツに数えない block(`<style>`・地の文)には番号を振らない(呼び出し側は `ページN` を出す)。
 */
function partLabels(
  index: number,
  after: { key: string; el: HTMLElement }[],
  before: { key: string; el: HTMLElement }[],
  parts: PartIndex,
): Map<string, string> {
  const labelOf = new Map<string, string>();
  const afterKeys = new Set(after.map((b) => b.key));
  let seq = 0;
  for (const b of after) {
    if (parts.attached.has(b.el)) continue;
    seq++;
    labelOf.set(b.key, `ページ${index + 1}・パーツ${seq}`);
  }
  for (const b of before) {
    if (afterKeys.has(b.key) || parts.attached.has(b.el)) continue;
    seq++;
    labelOf.set(b.key, `ページ${index + 1}・パーツ${seq}`);
  }
  return labelOf;
}

function diffPage(
  index: number,
  beforePage: HTMLElement[],
  afterPage: HTMLElement[],
  budget: LcsBudget,
  parts: PartIndex,
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
  const labelOf = partLabels(index, after, before, parts);
  for (const key of keys) {
    const bEl = beforeMap.get(key);
    const aEl = afterMap.get(key);
    const r = renderBlock(bEl, aEl, budget);
    rendered.set(key, r);
    const el = aEl ?? bEl;
    blocks.push({
      key,
      partKey: (el && parts.keys.get(el)) ?? key,
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

/**
 * ページ分けとパーツの番号に数える要素(`pageItems`。`<style>` と地の文の合成 `span` を除く)
 * だけを `splitPages` で分け、残り(付き従う block)をそのページへ戻す。承認タブ
 * (`reviews/services/reviewCompareDocs.ts`)は同じ `pageItems` でページを数え、その番号を
 * ここの `diff.pages` の番号と突き合わせるので、付き従う block がページを作ったりずらしたり
 * してはいけない。付き従う block は差分には出す(保存される内容で、承認者が見る必要がある)。
 * 直前の要素が区切り(または inline の `after` を持つパーツ)なら次の要素(パーツか区切り)の
 * ページへ、そうでなければ直前のパーツのページへ入れる(canvas の `markPages` と同じ)。区切りは
 * 置かれたページ(`breakPages`)で数えるので、区切りの間の付き従う block は白紙のページに入る。
 * 前後に要素が無ければ最寄りのページへ入れる。
 */
function splitTopLevel(blocks: HTMLElement[], attached: Set<HTMLElement>): HTMLElement[][] {
  const split = splitPages(blocks.filter((el) => !attached.has(el)));
  const { pages } = split;
  if (attached.size === 0) return pages;
  const pageOf = new Map<HTMLElement, number>();
  pages.forEach((page, i) => {
    for (const el of page) pageOf.set(el, i);
  });
  const breaks = new Set(split.breakEls);
  split.breakEls.forEach((el, i) => {
    pageOf.set(el, split.breakPages[i]);
  });
  const out: HTMLElement[][] = pages.map(() => []);
  let cur = 0;
  let broken = false;
  let held: HTMLElement[] = [];
  for (const el of blocks) {
    const page = pageOf.get(el);
    if (attached.has(el)) {
      if (broken) held.push(el);
      else out[cur].push(el);
    } else if (page !== undefined) {
      cur = page;
      out[cur].push(...held);
      held = [];
      // 区切りの要素はパーツに数えない(差分の block にしない)。
      if (breaks.has(el)) {
        broken = true;
      } else {
        out[cur].push(el);
        broken = inlineBreak(el, 'after');
      }
    }
  }
  out[cur].push(...held);
  return out;
}

/** before/after の両文書ぶんの、block の要素ごとの情報。 */
interface PartIndex {
  /** 文書全体のキー(`DiffBlock.partKey`)。 */
  keys: Map<HTMLElement, string>;
  /** パーツに数えない付き従う block(`<style>`・地の文の合成 `span`)。 */
  attached: Set<HTMLElement>;
}

function newPartIndex(): PartIndex {
  return { keys: new Map(), attached: new Set() };
}

/**
 * HTML を改ページで top-level page 群へ分割し、各 block の文書全体のキーと、パーツに数えない
 * block を `parts` へ書く。キーは `@/lib/blockKey` の `occurrenceKey(part, 全パーツ)` と同じ値
 * だが、パーツごとに全パーツを走査すると直下要素数の二乗になるので、出現順の数え上げを 1 回で
 * 済ませる。付き従う block(`pageItems` に入らない要素と地の文)は、パーツのアンカーと重ならない
 * 別の名前(`#attached` / `#text`)で数える。`rawKey` で数えると、パーツと同じクラスを持つ
 * `<style class="a">` が `.a` の番号を進め、canvas と承認タブ(`partKey.ts`)とキーが食い違う。
 */
function paginateDoc(
  html: string,
  parse: HtmlParser,
  parts: PartIndex,
): { pages: HTMLElement[][]; truncated: boolean } {
  const top = topLevelBlocks(parseBody(html, parse));
  const counted = new Set(pageItems(top.blocks.filter((el) => !top.texts.has(el))));
  const attached = new Set(top.blocks.filter((el) => !counted.has(el)));
  const pages = splitTopLevel(top.blocks, attached);
  const flat = pages.flat();
  const keys = occurrenceKeys(
    flat.map((el) => (top.texts.has(el) ? '#text' : attached.has(el) ? '#attached' : rawKey(el))),
  );
  flat.forEach((el, i) => {
    if (attached.has(el)) parts.attached.add(el);
    parts.keys.set(el, keys[i]);
  });
  return { pages, truncated: top.truncated };
}

/** ペア配列の各 page を diff する共通本体。`buildHtmlDiff`/`buildHtmlDiffAligned` の合流点。 */
function diffPairs(
  beforePages: HTMLElement[][],
  afterPages: HTMLElement[][],
  pairs: PagePair[],
  truncated: boolean,
  parts: PartIndex,
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
    pages.push(fastSamePage(i, bp, ap, parts) ?? diffPage(i, bp, ap, budget, parts));
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
 * `_cssBefore`/`_cssAfter` は改ページの判定に使わない(改ページは `<body>` 直下の
 * `div.pagebreak` と inline の指定だけで決める)。引数は Worker の契約と呼び出し側を
 * 動かさないために残している。
 */
export function buildHtmlDiff(
  beforeHtml: string,
  afterHtml: string,
  _cssBefore?: string,
  _cssAfter?: string,
  parse: HtmlParser = defaultHtmlParser,
): HtmlDiff {
  const parts = newPartIndex();
  const before = paginateDoc(beforeHtml, parse, parts);
  const after = paginateDoc(afterHtml, parse, parts);
  // 恒等 pairs(i↔i、範囲外側は null)で合流。出力は従来と不変。
  const pageCount = Math.max(before.pages.length, after.pages.length);
  const pairs: PagePair[] = Array.from({ length: pageCount }, (_, i) => ({
    before: i < before.pages.length ? i : null,
    after: i < after.pages.length ? i : null,
  }));
  return diffPairs(before.pages, after.pages, pairs, before.truncated || after.truncated, parts);
}

/**
 * `buildHtmlDiff` の対応付けをユーザー指定の `pairs` で駆動する版。比較画面でページを
 * ずらして「指定ページ同士」を並べるのに使う。`pairs` の各要素が結果の 1 ページに対応し、
 * `before`/`after` がそのページに置くソースページ index(`null` は対応なし)。
 * `_cssBefore`/`_cssAfter` は `buildHtmlDiff` と同じく改ページの判定に使わない。
 */
export function buildHtmlDiffAligned(
  beforeHtml: string,
  afterHtml: string,
  _cssBefore: string | undefined,
  _cssAfter: string | undefined,
  pairs: PagePair[],
  parse: HtmlParser = defaultHtmlParser,
): HtmlDiff {
  const parts = newPartIndex();
  const before = paginateDoc(beforeHtml, parse, parts);
  const after = paginateDoc(afterHtml, parse, parts);
  return diffPairs(before.pages, after.pages, pairs, before.truncated || after.truncated, parts);
}
