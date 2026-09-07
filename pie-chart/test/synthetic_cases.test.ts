// =============================================================================
// synthetic_cases.test.ts — 合成ケース生成器の不変則
// =============================================================================
// ハッシュ定数表 (`renderHashExpected.ts`) はケースごとの出力を固定するが、「ケースが互いに
// 別の入力である」ことは固定しない。値 0 の項目が正規化で落ちて別ケースと同一入力へ潰れる形は
// 定数表を素通りする (潰れた側のハッシュがもう一方と一致するだけで緑になり、そのケースは
// 何も守らなくなる)。生成器の側の性質としてここで固定する。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { syntheticCases } from './helpers/syntheticCases.js';

describe('syntheticCases', () => {
  it('どのケースも値 0 の項目を持たない (正規化で項目が落ちて別ケースと同一入力にならない)', () => {
    for (const [name, items] of Object.entries(syntheticCases())) {
      expect(
        items.every((i) => i.value > 0),
        name,
      ).toBe(true);
    }
  });

  it('gen_long_14_other は 14 項目で、gen_long_12_other とは異なる入力', () => {
    const cases = syntheticCases();
    expect(cases.gen_long_14_other).toHaveLength(14);
    expect(cases.gen_long_14_other).not.toEqual(cases.gen_long_12_other);
  });

  it('26 ケースの入力が互いに相異なる (別名なのに同一入力のケースを作らない)', () => {
    const entries = Object.entries(syntheticCases());
    expect(entries).toHaveLength(26);
    // 比較は正規化 (`|value| > 0` フィルタ) を通した後の姿で行う。潰れは値 0 の項目が落ちた
    // 結果として起きるため、生成直後の配列どうしを比べても検出できない。
    const normalized = entries.map(([, items]) =>
      JSON.stringify(items.filter((i) => i.value !== 0)),
    );
    expect(new Set(normalized).size).toBe(26);
  });

  it('各ケースの値の合計は 100', () => {
    for (const [name, items] of Object.entries(syntheticCases())) {
      const sum = Math.round(items.reduce((s, i) => s + i.value, 0) * 10) / 10;
      expect(sum, name).toBe(100);
    }
  });
});
