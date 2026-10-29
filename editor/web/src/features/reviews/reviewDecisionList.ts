// =============================================================================
// reviewDecisionList.ts — 承認タブの右欄の表示窓と、却下の理由の検査(純関数)
// =============================================================================
// 1. 表示窓: 変更は数百〜千件になり得るので、右欄「変更と判定」は `[start, end)` の窓だけを描き、
//    上下は見込み高の余白で埋める(設計書 D8)。窓の動かし方とスクロール補正の量をここに切り出し、
//    `ReviewDecisionList.vue` は DOM の測定と `scrollTop` の書き込みだけを持つ。位置が実際に
//    動かないことは e2e で測る。
// 2. 却下の理由: パーツの却下(右欄の行・まとめて却下)と申請ごと却下(`ReviewDetail.vue`)が共用
//    する。上限は shared の契約と同じ定数で、長さは送る形(前後の空白を除いたあと)で数える。

import { MAX_PART_REJECT_REASON_CHARS, MAX_REVIEW_REJECT_REASON_CHARS } from '@editor/shared';

// ── 1. 表示窓 ──

/** 番兵が見えたときに足す行数、初めに描く行数。 */
export const ROW_STEP = 50;
/** 同時に描く行の上限。 */
export const ROW_WINDOW_MAX = 150;
/** 描かない行の余白の見込み高(px)。 */
export const ROW_HEIGHT_ESTIMATE = 96;

export interface RowWindow {
  /** 描く先頭の index(0 始まり、含む)。 */
  start: number;
  /** 描く末尾の index(含まない)。 */
  end: number;
}

export function initialWindow(total: number): RowWindow {
  return { start: 0, end: Math.min(total, ROW_STEP) };
}

/** 全件の数が変わったときに窓を収め直す。空になった窓は先頭側へ広げ直す。 */
export function clampWindow(w: RowWindow, total: number): RowWindow {
  let end = Math.min(w.end, total);
  const start = Math.min(w.start, Math.max(0, end - ROW_STEP));
  end = Math.max(end, Math.min(total, start + ROW_STEP));
  return { start, end };
}

/** 下へ `ROW_STEP` 行足す。上限を超えた分は上から外し、その行数を `droppedTop` で返す。 */
export function growDown(w: RowWindow, total: number): { next: RowWindow; droppedTop: number } {
  const end = Math.min(total, w.end + ROW_STEP);
  const start = Math.max(w.start, end - ROW_WINDOW_MAX);
  return { next: { start, end }, droppedTop: start - w.start };
}

/** 上へ `ROW_STEP` 行戻す。上限を超えた分は下から外す。足した行数を `addedTop` で返す。 */
export function growUp(w: RowWindow): { next: RowWindow; addedTop: number } {
  const start = Math.max(0, w.start - ROW_STEP);
  const end = Math.min(w.end, start + ROW_WINDOW_MAX);
  return { next: { start, end }, addedTop: w.start - start };
}

/** index `i` の行を中ほどに置く窓 `[i-50, i+50)`。途中の行は描き足さない(決め事 9)。 */
export function windowAround(i: number, total: number): RowWindow {
  return { start: Math.max(0, i - ROW_STEP), end: Math.min(total, i + ROW_STEP) };
}

/**
 * 窓の上端で足した・外した行の、実際の高さと見込み高の差 `Δ`。上へ足したときは
 * `scrollTop += Δ`、上から外したときは `scrollTop -= Δ` とすると見えている行が動かない
 * (行が見込み高の余白に置き換わる、またはその逆なので、差の分だけ内容がずれる)。
 */
export function scrollDelta(
  heights: readonly number[],
  estimate: number = ROW_HEIGHT_ESTIMATE,
): number {
  let sum = 0;
  for (const h of heights) sum += h;
  return sum - estimate * heights.length;
}

// ── 2. 却下の理由 ──

/**
 * 却下の理由の上限(UTF-16 単位)。契約(`ReviewPartDecisionChange`)と同じ shared の定数で、
 * 超えた理由はサーバが契約の段で拒むので送らせない。
 */
export const REJECT_REASON_MAX = MAX_PART_REJECT_REASON_CHARS;

/** 申請ごと却下の理由の上限(UTF-16 単位)。契約(`ReviewRejectBody`)と同じ shared の定数。 */
export const REQUEST_REJECT_REASON_MAX = MAX_REVIEW_REJECT_REASON_CHARS;

/**
 * 却下の理由の長さ(UTF-16 単位)。画面は理由の前後の空白を除いて送るので、除いたあとで数える。
 * サーバの契約は受けた文字列(= 除いたあと)に上限を掛けるので、画面とサーバで同じ長さになる。
 */
export function reasonLength(text: string): number {
  return text.trim().length;
}

/** 却下の理由を送れない訳。送れるなら null。空白だけの理由は空と読む(サーバも trim する)。 */
export function rejectReasonProblem(
  text: string,
  max: number = REJECT_REASON_MAX,
): 'empty' | 'tooLong' | null {
  if (!text.trim()) return 'empty';
  if (reasonLength(text) > max) return 'tooLong';
  return null;
}
