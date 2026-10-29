// =============================================================================
// reviewedCandidate.ts — パーツ判定を当てた最終候補(承認画面の表示と承認の確定で共有)
// =============================================================================
// 役割: 差分(`htmlDiff.ts` の `HtmlDiff`)に保存済みのパーツ判定を当て、承認すると何が確定される
// かを組み立てる。承認画面はこれを最終候補として見せ、サーバの確定(edit 経路)は同じ関数の
// 判定不足で確定を止める。画面とサーバで判定の当て方が違うと、承認者が見た候補と確定される本文が
// ずれるので、1 か所に置く。
/// <reference lib="dom" />

import type { CreateReviewPartDecision } from '../reviewParts.js';
import type { DiffBlock, DiffPage, HtmlDiff } from './htmlDiff.js';
import { PAGEBREAK_CLASS } from './pageSplit.js';

/** 判定を当てた最終候補と、確定を止める判定不足。 */
export interface ReviewedHtmlCandidate {
  /** 判定を当てた装飾なしの本文 HTML(承認画面の表示用)。 */
  html: string;
  /** 変更のあるパーツのうち、判定が保存されていないもの。 */
  pendingPartKeys: string[];
  /** 現在の差分対象に存在しない保存済み判定。 */
  unknownDecisionPartKeys: string[];
  /** 同じパーツに複数ある判定(どれを当てるか決められないので確定を止める)。 */
  duplicateDecisionPartKeys: string[];
}

/** パーツ判定の状態(保存形式の `ReviewPartDecision` のうち、当てるのに使う部分)。 */
type PartDecisionState = CreateReviewPartDecision;

/**
 * 申請版の順序を基準にし、申請版から消えた却下パーツを比較元の位置へ戻す。`selectedHtml` が
 * 空のキーは候補に出ない(承認した削除・却下した追加)。
 */
export function reviewedPageOrder(
  beforeKeys: readonly string[],
  afterKeys: readonly string[],
  selectedHtml: ReadonlyMap<string, string>,
): string[] {
  const order = afterKeys.filter((key) => (selectedHtml.get(key) ?? '') !== '');

  for (let index = 0; index < beforeKeys.length; index++) {
    const key = beforeKeys[index];
    if ((selectedHtml.get(key) ?? '') === '' || order.includes(key)) continue;

    let previous: string | undefined;
    for (let i = index - 1; i >= 0; i--) {
      if (order.includes(beforeKeys[i])) {
        previous = beforeKeys[i];
        break;
      }
    }

    if (previous !== undefined) {
      order.splice(order.lastIndexOf(previous) + 1, 0, key);
      continue;
    }

    let next: string | undefined;
    for (let i = index + 1; i < beforeKeys.length; i++) {
      if (order.includes(beforeKeys[i])) {
        next = beforeKeys[i];
        break;
      }
    }

    if (next !== undefined) order.splice(order.indexOf(next), 0, key);
    else order.push(key);
  }

  return order;
}

/** 1 パーツについて、判定を当てた後に残る生 HTML(残らなければ空)。 */
function selectedHtmlOf(block: DiffBlock, decision: PartDecisionState | undefined): string {
  if (block.status === 'same') return block.rawAfterHtml;
  const approved = decision?.status === 'approved';
  if (block.status === 'changed') return approved ? block.rawAfterHtml : block.rawBeforeHtml;
  if (block.status === 'added') return approved ? block.rawAfterHtml : '';
  return approved ? '' : block.rawBeforeHtml;
}

/**
 * 1 ページぶんの、判定を当てた後のパーツの並び(`DiffBlock.key`)と各パーツの生 HTML。
 * `endsWithInlineBreak` は、残る最後のパーツが inline の `break-after` で改ページするか
 * (残すパーツが無ければ false)。申請版に無いページを後ろへ戻すとき、区切りを足すかを決める。
 */
export function reviewedPage(
  page: DiffPage,
  decisionByPartKey: ReadonlyMap<string, PartDecisionState>,
): { order: string[]; selectedHtml: Map<string, string>; endsWithInlineBreak: boolean } {
  const selectedHtml = new Map<string, string>();
  for (const block of page.blocks) {
    selectedHtml.set(block.key, selectedHtmlOf(block, decisionByPartKey.get(block.partKey)));
  }
  const order = reviewedPageOrder(page.beforeKeys, page.afterKeys, selectedHtml);
  const lastKey = order.at(-1);
  const last = page.blocks.find((block) => block.key === lastKey);
  const keepsAfter =
    last !== undefined &&
    last.status !== 'removed' &&
    selectedHtml.get(last.key) === last.rawAfterHtml;
  const endsWithInlineBreak =
    last !== undefined && (keepsAfter ? last.afterBreakAfter : last.beforeBreakAfter);
  return { order, selectedHtml, endsWithInlineBreak };
}

/**
 * 保存済みパーツ判定を適用し、装飾なしの最終候補HTMLと判定不足を返す。
 *
 * - 保存済みの `pending` は判定が無いのと同じに数える(承認も却下もされていない)。
 * - 同じパーツの判定が複数あれば `duplicateDecisionPartKeys` に返す。候補には後のものを当てる。
 * - 申請版にあるページは中身が空になっても区切りを残す。確定の書込(`editReviewedHtml.ts`)は
 *   申請のバイトの区切りに触れないので、候補もページの数を保たないと見せたものと書くものがずれる。
 *   申請版に無いページ(比較元にだけあるページ)は、却下した削除が残るときだけ区切りを足す。
 */
export function buildReviewedHtmlCandidate(
  diff: HtmlDiff,
  decisions: readonly PartDecisionState[],
): ReviewedHtmlCandidate {
  const decisionByPartKey = new Map<string, PartDecisionState>();
  const duplicates = new Set<string>();
  for (const decision of decisions) {
    if (decisionByPartKey.has(decision.partKey)) duplicates.add(decision.partKey);
    decisionByPartKey.set(decision.partKey, decision);
  }
  const pendingPartKeys: string[] = [];
  const knownPartKeys = new Set<string>();

  const pages = diff.pages.map((page) => {
    for (const block of page.blocks) {
      knownPartKeys.add(block.partKey);
      // ページを移ったパーツは削除と追加の 2 つの block に同じ partKey で現れるので、1 回だけ数える。
      if (
        block.status !== 'same' &&
        !isDecided(decisionByPartKey.get(block.partKey)) &&
        !pendingPartKeys.includes(block.partKey)
      ) {
        pendingPartKeys.push(block.partKey);
      }
    }
    const { order, selectedHtml, endsWithInlineBreak } = reviewedPage(page, decisionByPartKey);
    const text = order
      .map((key) => selectedHtml.get(key) ?? '')
      .filter((html) => html !== '')
      .join('\n');
    return { text, endsWithInlineBreak };
  });

  // ページは申請版の改ページ区切りで分かれているので、つなぐときに区切りを戻す。申請版に無い
  // ページは、前のページの最後のパーツが inline の `break-after` で改ページしていれば区切りを
  // 足さない(足すと白紙のページができる。確定の書込も同じ規則)。
  const sep = `\n<div class="${PAGEBREAK_CLASS}"></div>\n`;
  let html = '';
  let previousEndsWithInlineBreak = false;
  diff.pages.forEach((_page, index) => {
    const { text, endsWithInlineBreak } = pages[index];
    const appended = index >= diff.afterPageCount;
    if (appended && text === '') return;
    if (index > 0) html += appended && previousEndsWithInlineBreak ? '\n' : sep;
    html += text;
    previousEndsWithInlineBreak = text !== '' && endsWithInlineBreak;
  });
  return {
    html,
    pendingPartKeys,
    // `pending` は判定が無いのと同じ(取り消しで残った本文に無いキーで最終確定を止めない)。
    unknownDecisionPartKeys: [...decisionByPartKey]
      .filter(([partKey, decision]) => isDecided(decision) && !knownPartKeys.has(partKey))
      .map(([partKey]) => partKey),
    duplicateDecisionPartKeys: [...duplicates],
  };
}

/** 承認か却下が保存されているか(`pending` は判定が無いのと同じ)。 */
function isDecided(decision: PartDecisionState | undefined): boolean {
  return decision !== undefined && decision.status !== 'pending';
}
