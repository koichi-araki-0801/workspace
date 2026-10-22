// =============================================================================
// commonSample.test.ts — 共通サンプルの行を 1 つの sample へ合成する規則
// =============================================================================
import { sampleCommon } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { COMMON_SAMPLE_SEED_ROWS } from '../scripts/commonSampleSeed.js';
import { type CommonSampleRow, mergeCommonSampleRows } from '../src/repositories/commonSample.js';

const row = (
  id: number,
  data: unknown,
  cls: Partial<Pick<CommonSampleRow, 'category' | 'major' | 'middle' | 'minor'>> = {},
): CommonSampleRow => ({
  id,
  category: cls.category ?? null,
  major: cls.major ?? null,
  middle: cls.middle ?? null,
  minor: cls.minor ?? null,
  dataJson: typeof data === 'string' ? data : JSON.stringify(data),
});

describe('mergeCommonSampleRows', () => {
  it('ID 昇順にトップレベルのキーを足す', () => {
    const { sample, warnings } = mergeCommonSampleRows([
      row(2, { b: 2 }),
      row(1, { a: 1 }),
      row(3, { c: 3 }),
    ]);
    expect(Object.keys(sample)).toEqual(['a', 'b', 'c']);
    expect(warnings).toEqual([]);
  });

  it('同じキーは先の行を採り、キーと両方の分類を warnings に積む', () => {
    const { sample, warnings } = mergeCommonSampleRows([
      row(1, { holdings: [1] }, { category: '当ファンドのデータ', major: '組入上位銘柄' }),
      row(2, { holdings: [2] }),
    ]);
    expect(sample.holdings).toEqual([1]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('holdings');
    expect(warnings[0]).toContain('当ファンドのデータ/組入上位銘柄');
    expect(warnings[0]).toContain('全体共通');
  });

  it('壊れた JSON・トップレベルが object でない行は飛ばして warnings に積む', () => {
    const { sample, warnings } = mergeCommonSampleRows([
      row(1, '{not json'),
      row(2, [1, 2]),
      row(3, 'null'),
      row(4, { ok: true }),
    ]);
    expect(sample).toEqual({ ok: true });
    expect(warnings).toHaveLength(3);
  });

  it('入れ子の中は混ぜない', () => {
    const { sample, warnings } = mergeCommonSampleRows([
      row(1, { fund: { a: 1 } }),
      row(2, { fund: { b: 2 } }),
    ]);
    expect(sample.fund).toEqual({ a: 1 });
    expect(warnings).toHaveLength(1);
  });

  it('__proto__ のキーはプロトタイプを差し替えず、own のキーとして入る', () => {
    const { sample, warnings } = mergeCommonSampleRows([
      row(1, '{"__proto__": {"polluted": 1}, "a": 1}'),
    ]);
    expect(Object.getPrototypeOf(sample)).toBe(Object.prototype);
    expect((sample as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(sample, '__proto__')).toBe(true);
    expect(Object.keys(sample)).toEqual(['__proto__', 'a']);
    expect(warnings).toEqual([]);
  });

  it('行が無ければ空の sample と空の warnings', () => {
    expect(mergeCommonSampleRows([])).toEqual({ sample: {}, warnings: [] });
  });

  it('seed の行を合成すると sampleCommon と一致し、警告が出ない', () => {
    const rows = COMMON_SAMPLE_SEED_ROWS.map((r, i) =>
      row(i + 1, JSON.stringify(r.data), {
        category: r.category,
        major: r.major,
        middle: r.middle,
        minor: r.minor,
      }),
    );
    const { sample, warnings } = mergeCommonSampleRows(rows);
    expect(sample).toEqual(sampleCommon);
    expect(warnings).toEqual([]);
  });
});
