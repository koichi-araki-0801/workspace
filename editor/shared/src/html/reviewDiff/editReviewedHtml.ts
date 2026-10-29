// =============================================================================
// editReviewedHtml.ts — edit 申請の最終確定で書く本文(判定を当てたもの)
// =============================================================================
// 役割: 値入り HTML の申請(`origin='edit'`)を最終確定するとき、承認画面と同じ差分
// (`htmlDiff.ts`。比較元 = 申請時点の現行版 `baseHtml`、比較先 = 申請の `html`)と同じ判定の当て方
// (`reviewedCandidate.ts`)で検査し、却下したパーツだけを申請時点の現行版へ戻した本文を返す。
// サーバ(`server/src/repositories/reviewRepo.ts`、パーサは linkedom)が使い、web の承認画面の
// 最終候補(`DOMParser`)とも同じ差分の規則にそろえる。
//
// 書く本文は DOM から作らない。差分で決めた却下パーツの範囲だけを、申請と現行版の原文から
// 切り貼りする(本文直下の範囲は `reviewParts.ts` の `extractBodyUnits`)。DOM で再直列化すると
// 承認・same のパーツや区切り・コメント・空白まで書式が変わり、承認直後のペア同期が触っていない
// パーツを「変更」として転写する(設計正典の DOM round-trip 禁止)。差分の本文直下の並びと原文の
// 範囲は、名前の並びが全部一致し、触る範囲を単独で読み直した生 HTML が差分の生 HTML と一致した
// ときだけ対応するとみなす。合わなければ書かずに 409 を返す(申請し直してもらう)。
/// <reference lib="dom" />

import { conflict, validation } from '../../errors.js';
import {
  type BodyUnitRange,
  type CreateReviewPartDecision,
  extractBodyUnits,
} from '../reviewParts.js';
import {
  buildHtmlDiff,
  collapse,
  type DiffBlock,
  fragmentUnitHtml,
  type HtmlDiff,
  topLevelUnitNames,
} from './htmlDiff.js';
import type { HtmlParser } from './htmlParser.js';
import { PAGEBREAK_CLASS } from './pageSplit.js';
import { buildReviewedHtmlCandidate, reviewedPage } from './reviewedCandidate.js';

/**
 * 文言・監査ログに並べるパーツのキーの上限(それ以上は件数だけ出す)。最終確定を止める理由
 * (判定バーとサーバの 400)、判定の保存の 400・409(`server/src/repositories/reviewRepo.ts`)、
 * 監査ログの `partKeys`(`server/src/routes/reviews.routes.ts`)で同じ値を使う。1 回の判定は
 * 5,000 件まで受けるので、全キーを 1 行に連ねない。
 */
export const MAX_LISTED_PART_KEYS = 20;

/**
 * 文言に添えるキーの並び。先頭 `max` 件だけを並べ、残りは件数だけにする(1 回の判定は 5,000 件まで
 * 受けるので、全キーを文言へ連ねない)。サーバの判定の保存の 400・409 も使う(`reviewRepo.ts`)。
 */
export function partKeysText(keys: readonly string[], max: number = MAX_LISTED_PART_KEYS): string {
  const listed = keys.slice(0, max).join(', ');
  return keys.length > max ? `${listed} ほか${keys.length - max}件` : listed;
}

const keysText = (keys: readonly string[]): string => partKeysText(keys);

/**
 * 最終確定を止める理由の文言。承認画面(`ReviewDetail.vue` の `finalizationBlocked`)とサーバの
 * 400 が同じ文言を出す。`legacyDecisions` は、比較元の無い古い edit 申請に判定が保存されている状態。
 */
export function reviewFinalizationIssues(state: {
  pendingPartKeys: readonly string[];
  unknownDecisionPartKeys: readonly string[];
  duplicateDecisionPartKeys: readonly string[];
  truncated: boolean;
  legacyDecisions?: boolean;
}): string[] {
  const issues: string[] = [];
  if (state.pendingPartKeys.length > 0) {
    issues.push(
      `未判定の変更が ${state.pendingPartKeys.length} 件あるため最終確定できません: ` +
        keysText(state.pendingPartKeys),
    );
  }
  if (state.unknownDecisionPartKeys.length > 0) {
    issues.push(
      `現在の差分対象と一致しない保存済み判定が ${state.unknownDecisionPartKeys.length} 件あるため` +
        `最終確定できません: ${keysText(state.unknownDecisionPartKeys)}`,
    );
  }
  if (state.duplicateDecisionPartKeys.length > 0) {
    issues.push(
      `同じパーツの判定が複数あるため最終確定できません: ${keysText(state.duplicateDecisionPartKeys)}`,
    );
  }
  if (state.truncated) {
    issues.push(
      '差分の上限を超えて承認者に表示できない部分があるため最終確定できません。' +
        '本文を分けて申請し直してください。',
    );
  }
  if (state.legacyDecisions) {
    issues.push(LEGACY_DECISIONS_MESSAGE);
  }
  return issues;
}

/** 比較元(`baseHtml` / `baseCss`)を持たない古い edit 申請に判定がある場合の文言。 */
const LEGACY_DECISIONS_MESSAGE =
  '申請時点の比較元が保存されていない古い申請のため、パーツの判定を反映して最終確定できません。' +
  '申請し直してください。';

/** 切り貼りの対応が取れないときの文言(書かずに 409 を返す)。 */
const SPLICE_MISMATCH_MESSAGE =
  '却下したパーツを申請の本文へ戻す位置を確かめられないため、最終確定できません。申請し直してください。';

/**
 * サーバの 400 の文言に足す案内。画面の差分は Worker(linkedom)が落ちるとメインスレッドの
 * `DOMParser` で作られ、崩れた markup ではパーツの数え方がサーバ(linkedom)とずれうる。
 */
const RELOAD_HINT = '画面を再読み込みして判定し直してください。直らなければ申請し直してください。';

/** edit 申請の確定に要る申請の中身(`StoredReviewRequest` の一部)。 */
export interface EditReviewSource {
  html: string;
  baseHtml?: string;
  baseCss?: string;
  partDecisions?: readonly CreateReviewPartDecision[];
}

/**
 * edit 申請の最終確定で書く本文を返す。`currentHtml` は確定の直前の値入り HTML(`filled/`)。
 *
 * 1. 比較元(`baseHtml` / `baseCss`)の無い古い申請: 判定が無ければ申請の本文をそのまま返し、
 *    判定があれば 409(当てる差分が作れない)。
 * 2. 画面と同じ差分と判定の当て方で、未判定(`pending` を含む)・本文に無い判定・判定の重複・
 *    差分の打ち切りがあれば 400。
 * 3. 却下が無ければ申請の本文をそのまま返す。
 * 4. 却下があり、確定の直前の値入り HTML が申請時点(`baseHtml`)から変わっていれば 409。却下は
 *    申請時点の版へ戻す操作なので、後から入った確定を巻き戻さない(CSS は比べない)。
 * 5. 却下したパーツだけを切り貼りした本文を返す(合わなければ 409)。
 *
 * `diff` は呼び手が同じ申請について計算済みの差分(`buildHtmlDiff(baseHtml, html, parse)`)。
 * 申請の本文は申請のあと変わらないので使い回せる。無ければここで計算する。
 */
export function buildEditReviewedHtml(
  review: EditReviewSource,
  parse: HtmlParser,
  currentHtml: string,
  diff?: HtmlDiff,
): string {
  const decisions = review.partDecisions ?? [];
  if (review.baseHtml === undefined || review.baseCss === undefined) {
    if (decisions.length === 0) return review.html;
    throw conflict(LEGACY_DECISIONS_MESSAGE, { code: 'REVIEW_BASE_MISSING' });
  }

  const reviewDiff = diff ?? buildHtmlDiff(review.baseHtml, review.html, parse);
  const candidate = buildReviewedHtmlCandidate(reviewDiff, decisions);
  const issues = reviewFinalizationIssues({ ...candidate, truncated: reviewDiff.truncated });
  if (issues.length > 0) throw validation(`${issues.join(' ')} ${RELOAD_HINT}`);

  const decisionByPartKey = new Map(decisions.map((d) => [d.partKey, d]));
  const rejected = (block: DiffBlock) =>
    block.status !== 'same' && decisionByPartKey.get(block.partKey)?.status === 'rejected';
  if (!reviewDiff.pages.some((page) => page.blocks.some(rejected))) return review.html;

  if (currentHtml !== review.baseHtml) {
    throw conflict(
      '申請の後に現行版が変わったため、却下したパーツを申請時点の版へ戻して確定できません。' +
        '最新の現行版から申請し直してください。',
      { code: 'REVIEW_BASE_CHANGED' },
    );
  }

  return spliceRejected(reviewDiff, decisionByPartKey, review.baseHtml, review.html, parse);
}

/** 原文 1 本と、その本文直下の単位の範囲。 */
interface SourceDoc {
  html: string;
  units: BodyUnitRange[];
  bodyEnd: number;
}

/** 書込の 1 手(`end === at` なら挿入)。 */
interface Edit {
  at: number;
  end: number;
  text: string;
}

/** 原文の範囲を読み、差分の本文直下の並びと名前が全部一致することを確かめる。 */
function sourceDoc(html: string, parse: HtmlParser): SourceDoc {
  let scanned: ReturnType<typeof extractBodyUnits>;
  try {
    scanned = extractBodyUnits(html);
  } catch (cause) {
    throw conflict(SPLICE_MISMATCH_MESSAGE, { code: 'REVIEW_SPLICE_MISMATCH', cause });
  }
  const names = topLevelUnitNames(html, parse);
  if (
    names.length !== scanned.units.length ||
    names.some((name, i) => name !== scanned.units[i].name)
  ) {
    throw conflict(SPLICE_MISMATCH_MESSAGE, { code: 'REVIEW_SPLICE_MISMATCH' });
  }
  return { html, units: scanned.units, bodyEnd: scanned.bodyEnd };
}

/**
 * 単位 `unit` の原文の範囲。単独で読み直した生 HTML が差分の生 HTML(`expected`)と同じ 1 単位に
 * ならなければ、並びは同じでも中身の対応が取れていない(表の地の文の付け替えなど)ので止める。
 */
function verifiedRange(
  doc: SourceDoc,
  unit: number | null,
  expected: string,
  parse: HtmlParser,
): BodyUnitRange {
  const range = unit === null ? undefined : doc.units[unit];
  if (range) {
    const reread = fragmentUnitHtml(doc.html.slice(range.start, range.end), parse);
    if (reread.length === 1 && collapse(reread[0]) === collapse(expected)) return range;
  }
  throw conflict(SPLICE_MISMATCH_MESSAGE, { code: 'REVIEW_SPLICE_MISMATCH' });
}

/** 却下したパーツだけを申請の本文へ切り貼りする。承認・same のパーツとパーツの外は変えない。 */
function spliceRejected(
  diff: HtmlDiff,
  decisionByPartKey: ReadonlyMap<string, CreateReviewPartDecision>,
  beforeHtml: string,
  afterHtml: string,
  parse: HtmlParser,
): string {
  const before = sourceDoc(beforeHtml, parse);
  const after = sourceDoc(afterHtml, parse);
  const edits: Edit[] = [];
  const isRejected = (block: DiffBlock) =>
    decisionByPartKey.get(block.partKey)?.status === 'rejected';
  const beforeText = (block: DiffBlock) => {
    const range = verifiedRange(before, block.beforeUnit, block.rawBeforeHtml, parse);
    return before.html.slice(range.start, range.end);
  };
  let trailingBreakEnd = trailingBreakEndOf(diff, after);
  // 前のページ(残すパーツのあるページ)の最後のパーツが inline の `break-after` で改ページするか。
  // 最終候補(`reviewedCandidate.ts`)と同じ規則で、申請版に無いページの前に区切りを足すかを決める。
  let previousEndsWithInlineBreak = false;

  for (const page of diff.pages) {
    const blockByKey = new Map(page.blocks.map((block) => [block.key, block]));

    for (const block of page.blocks) {
      if (!isRejected(block)) continue;
      if (block.status === 'changed') {
        const range = verifiedRange(after, block.afterUnit, block.rawAfterHtml, parse);
        edits.push({ at: range.start, end: range.end, text: beforeText(block) });
      } else if (block.status === 'added') {
        const range = verifiedRange(after, block.afterUnit, block.rawAfterHtml, parse);
        edits.push({ at: range.start, end: range.end, text: '' });
      }
    }

    // 却下した削除は、候補と同じ並び(`reviewedPageOrder`)で申請の本文に残るパーツの間へ戻す。
    const { order, endsWithInlineBreak } = reviewedPage(page, decisionByPartKey);
    const entries = order.flatMap((key) => {
      const block = blockByKey.get(key);
      return block ? [block] : [];
    });
    const present = (block: DiffBlock) => block.status !== 'removed';
    // 申請版のこのページの最初のパーツ(却下して消す追加も含む)。戻す削除の前後に残るパーツが
    // 無いとき(削除と、それに代わる追加の両方を却下したなど)は、その前へ戻す。同じ位置の挿入は
    // 削除より先に当たるので(`applyEdits`)、消す追加の範囲に巻き込まれない。
    const firstAfter = page.afterKeys
      .map((key) => blockByKey.get(key))
      .find((block) => block !== undefined && block.afterUnit !== null);
    const insertion = (
      pageIndex: number,
      texts: string[],
      prev: DiffBlock | undefined,
      next: DiffBlock | undefined,
      breakUnit: number | null,
    ): Edit => {
      const joined = texts.join('\n');
      if (prev) {
        const range = verifiedRange(after, prev.afterUnit, prev.rawAfterHtml, parse);
        return { at: range.end, end: range.end, text: `\n${joined}` };
      }
      if (next) {
        const range = verifiedRange(after, next.afterUnit, next.rawAfterHtml, parse);
        return { at: range.start, end: range.start, text: `${joined}\n` };
      }
      if (firstAfter) {
        const range = verifiedRange(after, firstAfter.afterUnit, firstAfter.rawAfterHtml, parse);
        return { at: range.start, end: range.start, text: `${joined}\n` };
      }
      if (breakUnit !== null) {
        const range = after.units[breakUnit];
        return { at: range.start, end: range.start, text: `${joined}\n` };
      }
      if (pageIndex >= diff.afterPageCount) {
        // 申請版に無いページ。申請版が区切りで終わっていれば(最後の区切りは改ページしない)、
        // 最初のページはその区切りの後ろへ置く。それ以外は区切りを足して本文の末尾へ置く。
        if (trailingBreakEnd !== null) {
          const at = trailingBreakEnd;
          trailingBreakEnd = null;
          return { at, end: at, text: `\n${joined}` };
        }
        if (previousEndsWithInlineBreak) {
          return { at: after.bodyEnd, end: after.bodyEnd, text: `\n${joined}\n` };
        }
        const sep = `\n<div class="${PAGEBREAK_CLASS}"></div>\n`;
        return { at: after.bodyEnd, end: after.bodyEnd, text: `${sep}${joined}\n` };
      }
      throw conflict(SPLICE_MISMATCH_MESSAGE, { code: 'REVIEW_SPLICE_MISMATCH' });
    };

    let run: string[] = [];
    let previous: DiffBlock | undefined;
    const flush = (next: DiffBlock | undefined) => {
      if (run.length === 0) return;
      edits.push(insertion(page.index, run, previous, next, page.afterBreakUnit));
      run = [];
    };
    for (const block of entries) {
      if (present(block)) {
        flush(block);
        previous = block;
      } else if (isRejected(block)) {
        run.push(beforeText(block));
      }
    }
    flush(undefined);
    if (page.index < diff.afterPageCount || order.length > 0) {
      previousEndsWithInlineBreak = order.length > 0 && endsWithInlineBreak;
    }
  }

  return applyEdits(afterHtml, edits);
}

/**
 * 申請版の本文が区切りで終わるなら、その区切りの終わりの位置(終わらなければ null)。最後の
 * パーツ・区切りが申請版の最後のページに置かれた区切りなら、区切りで終わっている。地の文と
 * `<style>` はページを作らないので飛ばす。
 */
function trailingBreakEndOf(diff: HtmlDiff, after: SourceDoc): number | null {
  const lastPage = diff.pages[diff.afterPageCount - 1];
  let last = after.units.length - 1;
  while (last >= 0 && (after.units[last].name === '#text' || after.units[last].name === 'style')) {
    last--;
  }
  return lastPage && last >= 0 && lastPage.afterBreakUnit === last ? after.units[last].end : null;
}

/** 書込を前から順に当てる。同じ位置では挿入を置換より先に置く(戻したパーツは次のパーツの前)。 */
function applyEdits(html: string, edits: readonly Edit[]): string {
  const sorted = edits
    .map((edit, seq) => ({ edit, seq }))
    .sort(
      (a, b) =>
        a.edit.at - b.edit.at ||
        Number(a.edit.end !== a.edit.at) - Number(b.edit.end !== b.edit.at) ||
        a.seq - b.seq,
    );
  let out = '';
  let cursor = 0;
  for (const { edit } of sorted) {
    out += html.slice(cursor, edit.at) + edit.text;
    cursor = Math.max(cursor, edit.end);
  }
  return out + html.slice(cursor);
}
