// =============================================================================
// input_limits.test.ts — 資源上限(P021 / P037 / P038)の退行ガード
// =============================================================================
// pie-chart はオペレータが手元で回す CLI なので、上限超過は degrade でも既定への
// フォールバックでもなく**明示エラー**にする(黙って数時間回るのが最悪の壊れ方)。
// メッセージに「上限値・実際の値・上げ方」が入っていることまで固定する。
import { describe, expect, it } from 'vitest';
import { normalizeInputItems, parseRange, resolveInputData } from '../src/input/load.js';
import {
  MAX_JSON_BYTES,
  MAX_LABEL_CHARS,
  MAX_RANGE_ROWS,
  PIE_MAX_ITEMS,
  assertItemCount,
} from '../src/limits.js';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';

/** 上限値そのものをテストで固定する(値の変更に「テストを直す」意思決定を伴わせる)。 */
describe('上限値の固定', () => {
  it('件数上限は 32(n=32 で約 2 分・n=40 は 5 分でも未完了の実測に基づく)', () => {
    expect(PIE_MAX_ITEMS).toBe(32);
    expect(MAX_LABEL_CHARS).toBe(256);
    expect(MAX_RANGE_ROWS).toBe(10_000);
  });
});

const itemsOf = (n: number): Array<[string, number]> =>
  Array.from({ length: n }, (_, i) => [`項目${i}`, n - i] as [string, number]);

describe('項目数の上限(P021)', () => {
  it('上限超過は上限値・件数・上げ方を含むエラーになる', async () => {
    const err = await renderPdfStylePieToSvg(itemsOf(PIE_MAX_ITEMS + 1), {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(String(PIE_MAX_ITEMS + 1));
    expect(err.message).toContain(String(PIE_MAX_ITEMS));
    expect(err.message).toContain('PIE_MAX_ITEMS');
  });

  // 上限直下は通ること(上限が「正当な運用を止める」形で入っていないことの確認)。
  // 32 件のレイアウトは実測 2 分規模なので、判定関数 `assertItemCount` を直接見る
  // (実レンダリングを回すとテスト自体が上限の実演になってしまう)。
  it('上限直下(32 件)は判定を通る', () => {
    expect(() => assertItemCount(PIE_MAX_ITEMS)).not.toThrow();
    expect(() => assertItemCount(PIE_MAX_ITEMS + 1)).toThrow(/PIE_MAX_ITEMS/);
  });
});

describe('ラベル長の上限(P037)', () => {
  it('上限超過は切り詰めずエラーにする(黙って出力が変わるのを避ける)', () => {
    const long = 'あ'.repeat(MAX_LABEL_CHARS + 1);
    expect(() => normalizeInputItems([[long, 1]])).toThrow(/PIE_MAX_LABEL_CHARS/);
    expect(() => normalizeInputItems([{ name: long, value: 1 }])).toThrow(/PIE_MAX_LABEL_CHARS/);
    expect(() => normalizeInputItems([['あ'.repeat(MAX_LABEL_CHARS), 1]])).not.toThrow();
  });
});

describe('range の行数上限(P038)', () => {
  it('A1:B99999999 は列幅検査を通っても行数で弾かれる', () => {
    // 旧実装は列幅 2 だけを見ていたため、数億行の Row/Cell 実体化が素通りしていた。
    expect(() => parseRange('A1:B99999999')).toThrow(/PIE_MAX_RANGE_ROWS/);
    expect(() => parseRange(`A1:B${MAX_RANGE_ROWS}`)).not.toThrow();
  });

  it('通常のレンジは従来どおり解釈する(回帰)', () => {
    expect(parseRange('A2:B11')).toEqual({ startRow: 2, endRow: 11, nameCol: 1, valueCol: 2 });
  });
});

describe('dataJson の長さ上限', () => {
  it('上限超過は JSON.parse の前に弾く', () => {
    const huge = `[${'"x",'.repeat(1)}]`.padEnd(MAX_JSON_BYTES + 1, ' ');
    expect(() => resolveInputData({ dataJson: huge })).toThrow(/PIE_MAX_JSON_BYTES/);
  });
});
