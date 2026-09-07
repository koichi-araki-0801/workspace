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
