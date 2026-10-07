// =============================================================================
// partBreak.ts — Inspector の「前で改ページ / 後で改ページ」の状態と、何を足す・消すかの決定
// =============================================================================
// 改ページはパーツ(内容の根の直下の要素)の前後に置く区切り(`<div class="pagebreak">`)で表す。
// inline の改ページ指定を書くと、canvas の帯・承認・比較が見る区切りと、利用者が Inspector で
// 見る状態が別の仕組みになるため、Inspector の操作も区切りの挿入・削除にそろえる。ただし既存の
// テンプレには inline の `break-*` で改ページしたパーツもあるので、状態は両方を見て、OFF は両方を
// 消す。inline の `page-break-*` と `break-*: always` は印刷で改ページしない(`@/lib/pageBreaks`)
// ので、状態は OFF と読む(警告欄で区切りへの置き換えを促す)。
//
// ここは DOM を読むだけの純粋関数で、GrapesJS の component への反映は `useGrapes.ts` の
// `setPartBreak` が受け持つ。数え方(どの要素を飛ばすか)は `@/lib/pageBreaks` の `pageItems` と
// 同じにし、canvas のページと Inspector の状態が食い違わないようにする。

import {
  ignoredInlineBreakProps,
  inlineBreak,
  isPagebreakEl,
  PAGEBREAK_CLASS,
  pageItems,
} from '@/lib/pageBreaks';

/** パーツの前か後ろか。 */
export type BreakEdge = 'before' | 'after';

/** 改ページの出どころ(区切りの要素か、パーツの inline `style` か)。 */
export type BreakSource = 'div' | 'inline';

/** パーツの前後の改ページの状態(無ければ null)。 */
export interface PartBreakState {
  before: BreakSource | null;
  after: BreakSource | null;
}

/** 1 回の切り替えで行う変更。 */
export interface BreakPlan {
  /** 区切りを挿入する位置(パーツの直前 / 直後)。挿入しなければ null。 */
  insert: BreakEdge | null;
  /** 消す区切りの要素(根の直下のもの)。 */
  remove: Element[];
  /** パーツの inline `style` から消すプロパティ。 */
  stripProps: string[];
}

/** 挿入する区切りの HTML。属性を足さない(自動 id などを保存内容に載せない)。 */
export const PAGEBREAK_HTML = `<div class="${PAGEBREAK_CLASS}"></div>`;

/**
 * パーツの隣に続く区切り(連続していれば全部)。赤入れの削除要素・`<style>`・描画で消えるチップは
 * `pageItems` が除くので飛ばして見る。固めた範囲の包みの中の区切りは、包みが保存で原文へ戻り
 * 消せないので数えない(そこで止める)。
 */
function adjacentBreaks(items: Element[], i: number, root: Element, edge: BreakEdge): Element[] {
  const step = edge === 'before' ? -1 : 1;
  const out: Element[] = [];
  for (let j = i + step; j >= 0 && j < items.length; j += step) {
    const el = items[j] as Element;
    if (!isPagebreakEl(el) || el.parentElement !== root) break;
    out.push(el);
  }
  return out;
}

/** `part` が根の直下のパーツなら、`pageItems` の並びとその位置。対象外なら null。 */
function locate(part: Element, root: Element): { items: Element[]; i: number } | null {
  if (part.parentElement !== root || isPagebreakEl(part)) return null;
  const items = pageItems(Array.from(root.children));
  const i = items.indexOf(part);
  return i < 0 ? null : { items, i };
}

/**
 * パーツの前後の改ページの状態。直前(直後)の兄弟が区切りなら `div`、そうでなく inline に
 * その端の改ページがあれば `inline`。根の直下のパーツでないもの(入れ子の要素・区切り自身・
 * 固めた範囲の包みとその中身)は区切りを置けないので null。包みの中身は原文から作り直すので、
 * 中に区切りを入れても保存で消える。
 */
export function partBreakState(part: Element, root: Element): PartBreakState | null {
  const at = locate(part, root);
  if (!at) return null;
  const read = (edge: BreakEdge): BreakSource | null => {
    if (adjacentBreaks(at.items, at.i, root, edge).length > 0) return 'div';
    return inlineBreak(part, edge) ? 'inline' : null;
  };
  return { before: read('before'), after: read('after') };
}

/**
 * 切り替えで行う変更を決める。状態が変わらない操作・対象外のパーツは null。
 *
 * ON はその端に区切りを 1 つ置き、その端の印刷では効かない inline の指定(`page-break-*` の
 * 改ページの値と `break-*: always`)を消す(区切りへの置き換えなので、警告の元を残さない)。
 * OFF は隣の区切りを連続分すべて消し(1 つでも残ると ON のまま)、
 * inline の該当の宣言(`break-*` と、一緒に書かれがちな効かない `page-break-*`)も消す。どちらで
 * 改ページしていても OFF が効く。連続した区切りは間に白紙のページを作るので、OFF でその白紙の
 * ページも消える。
 */
export function planBreakToggle(
  part: Element,
  root: Element,
  edge: BreakEdge,
  on: boolean,
): BreakPlan | null {
  const state = partBreakState(part, root);
  if (!state || (state[edge] !== null) === on) return null;
  if (on) return { insert: edge, remove: [], stripProps: ignoredInlineBreakProps(part, edge) };
  const at = locate(part, root) as { items: Element[]; i: number };
  return {
    insert: null,
    remove: adjacentBreaks(at.items, at.i, root, edge),
    stripProps: inlineBreak(part, edge) ? [`page-break-${edge}`, `break-${edge}`] : [],
  };
}

/** 修正履歴の文言。 */
export function partBreakLabel(edge: BreakEdge, on: boolean): string {
  return `「${edge === 'before' ? '前' : '後'}で改ページ」を${on ? '有効化' : '解除'}`;
}
