// =============================================================================
// pageNav.ts — ページ送り UI(`PageNav.vue` / `PageRail.vue`)の純粋ロジック
// =============================================================================
// 役割: ジャンプ入力欄のクランプと、スクラバレールの「縦位置比率 ⇔ ページ番号」写像を
// DOM 非依存の純粋関数に切り出したもの。400 ページ規模でも破綻しないページャの中核計算で、
// vitest で全分岐(端・超過・小数・NaN)を直接検証できるようにする。ページ番号はすべて
// 1 起点(画面表示と同じ)で扱う。

/**
 * 1 起点ページ番号を `[1, count]` に収める。`count <= 0` は 1、`NaN`/Infinity は 1 へ、
 * 小数は四捨五入する(入力欄に "3.7" や空文字が来ても安全化する)。
 */
export function clampPage(page: number, count: number): number {
  if (!Number.isFinite(page)) return 1;
  const max = Math.max(1, Math.floor(count));
  return Math.min(Math.max(Math.round(page), 1), max);
}

/**
 * レール上の縦位置比率(0..1)を 1 起点ページ番号へ写像する。各ページを均等区間に割り当て、
 * `floor(fraction * count) + 1` で「その位置に在るページ」を選ぶ(区間の上端 `fraction=1` は
 * `count` へ `clampPage` で丸まる)。比率が範囲外でも端へクランプする。
 */
export function fractionToPage(fraction: number, count: number): number {
  if (count <= 0) return 1;
  const f = Math.min(Math.max(fraction, 0), 1);
  return clampPage(Math.floor(f * count) + 1, count);
}

/**
 * 1 起点ページ番号を、つまみ/目盛り表示用の縦位置比率(0..1)へ写像する。`fractionToPage` の
 * 逆で、ページ区間の中央(`(page - 0.5) / count`)を返す(両端が track の端に寄り過ぎない)。
 */
export function pageToFraction(page: number, count: number): number {
  if (count <= 0) return 0;
  return (clampPage(page, count) - 0.5) / count;
}
