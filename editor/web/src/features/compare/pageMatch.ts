// =============================================================================
// pageMatch.ts — ページ対応(ずらし)指定の純粋ロジック
// =============================================================================
// 比較結果画面はページ対応を「行 r に対する offset」で保持する(`CompareResultView.vue`)。
// 番号を直接指定する操作は、その offset を逆算して置き換えるだけで表せる。数百ページ規模の
// 版では対応ページを候補から選べないため入力欄で受け取る前提で、入力文字列の解釈(空・非数値・
// 範囲外)もここへ集約して DOM 非依存に検証できるようにする。ページ index は 0 起点、
// 入力文字列と画面表示は 1 起点。
import { clampPage } from '@/components/pageNav';

/**
 * 行 `row` の当該側を「ページ index = `value`」にするための offset を返す。`value` が
 * `null`(対応なし)のときは行 index に依らず範囲外の `-1` へ落ちる offset を返す。
 */
export function directOffset(value: number | null, row: number): number {
  return value == null ? -row - 1 : value - row;
}

/**
 * 入力欄の文字列(1 起点)を 0 起点のページ index へ写す。範囲外は端へクランプし、空文字や
 * 非数値は `null` を返す(呼び出し側は元の値へ戻す)。`Number('')` が 0 になる罠を避けるため、
 * 空白のみの入力は数値化の前に弾く。
 */
export function parsePageIndex(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return clampPage(n, pageCount) - 1;
}

/** `layoutRows` の結果。offset 配列は `rowCount` 個にそろえてある。 */
export interface RowLayout {
  beforeOff: number[];
  afterOff: number[];
  rowCount: number;
  /** どの行にも出ないページ(0 起点)。 */
  missing: { before: number[]; after: number[] };
  /** 2 つ以上の行に出るページ(0 起点)。 */
  duplicated: { before: number[]; after: number[] };
}

// 配列の外の行は最後の offset を引き継ぐ。「以降も連動」のずらしが、足した行へも及ぶようにする。
function offsetAt(off: readonly number[], row: number): number {
  if (off.length === 0) return 0;
  return off[Math.min(row, off.length - 1)];
}

function shownPage(off: readonly number[], row: number, count: number): number | null {
  const p = row + offsetAt(off, row);
  return p >= 0 && p < count ? p : null;
}

/**
 * 行ごとの offset から、全ページを載せる行数と offset を組み立てる。
 *
 * ずらすと末尾のページが行の外へ押し出されて見えなくなるため、あふれたページの行を足す。
 * 途中で飛ばされたページは行を足しても出せない(利用者のずらし方の結果)ので、行は足さず
 * `missing` で知らせる。
 */
export function layoutRows(
  beforeOff: readonly number[],
  afterOff: readonly number[],
  beforeCount: number,
  afterCount: number,
): RowLayout {
  const baseRows = Math.max(beforeCount, afterCount, 1);
  const bOff = Array.from({ length: baseRows }, (_, r) => offsetAt(beforeOff, r));
  const aOff = Array.from({ length: baseRows }, (_, r) => offsetAt(afterOff, r));

  // ── 1. あふれたページの行を足す ──
  const overflow = (off: number[], count: number): number[] => {
    let max = -1;
    for (let r = 0; r < baseRows; r++) max = Math.max(max, shownPage(off, r, count) ?? -1);
    return Array.from({ length: Math.max(0, count - (max + 1)) }, (_, k) => max + 1 + k);
  };
  const bOver = overflow(bOff, beforeCount);
  const aOver = overflow(aOff, afterCount);
  const extra = Math.max(bOver.length, aOver.length);
  for (let k = 0; k < extra; k++) {
    const row = baseRows + k;
    bOff.push(k < bOver.length ? bOver[k] - row : directOffset(null, row));
    aOff.push(k < aOver.length ? aOver[k] - row : directOffset(null, row));
  }

  // 足した行は基準の行数から毎回組み直すので、ずらしを戻せば次の呼び出しで自然に無くなる。
  // 渡された offset の長さが基準を超えていても、超えた分は読まない。
  const rowCount = bOff.length;

  // ── 2. 出ないページと二重のページを数える ──
  const tally = (off: number[], count: number) => {
    const seen = new Array<number>(count).fill(0);
    for (let r = 0; r < rowCount; r++) {
      const p = shownPage(off, r, count);
      if (p != null) seen[p]++;
    }
    const missing: number[] = [];
    const duplicated: number[] = [];
    seen.forEach((n, p) => {
      if (n === 0) missing.push(p);
      else if (n > 1) duplicated.push(p);
    });
    return { missing, duplicated };
  };
  const b = tally(bOff, beforeCount);
  const a = tally(aOff, afterCount);
  return {
    beforeOff: bOff,
    afterOff: aOff,
    rowCount,
    missing: { before: b.missing, after: a.missing },
    duplicated: { before: b.duplicated, after: a.duplicated },
  };
}

const WARN_LIMIT = 10;

function pagesText(label: string, pages: readonly number[]): string | null {
  if (pages.length === 0) return null;
  const shown = pages
    .slice(0, WARN_LIMIT)
    .map((p) => p + 1)
    .join('・');
  const rest = pages.length - WARN_LIMIT;
  return `${label} ${shown}${rest > 0 ? ` ほか ${rest} ページ` : ''}`;
}

function sidesText(head: string, v: { before: readonly number[]; after: readonly number[] }) {
  const parts = [pagesText('比較元', v.before), pagesText('比較先', v.after)].filter(
    (x): x is string => x != null,
  );
  return parts.length === 0 ? null : `${head}: ${parts.join('、')}`;
}

/** 比較画面の警告 1 行。出ないページも二重のページも無ければ `null`。 */
export function alignWarningText(layout: RowLayout): string | null {
  const parts = [
    sidesText('どの行にも表示されていないページがあります', layout.missing),
    sidesText('2 つ以上の行に表示されているページがあります', layout.duplicated),
  ].filter((x): x is string => x != null);
  return parts.length === 0 ? null : parts.join(' / ');
}
