import { describe, expect, it } from 'vitest';
import {
  applyTemplateAttributes,
  buildSampleData,
  formatBaseDate,
  type SampleData,
  sampleCommon,
} from '../src/index';

// =============================================================================
// sampleData.test.ts — サンプルデータへのテンプレ属性の被せ方を固定する
// =============================================================================
// 版種・基準日はファイル名属性で、ファンド単位のサンプル(`getSampleData`/`sampleCommon`)
// は持たない・持てない。テンプレを開く文脈で `applyTemplateAttributes` が被せる、という
// 分担が崩れると「基準日が空のまま差し込まれる」画面欠落として現れる(実際に起きた)。

const ATTRS = { editionType: '交付版', baseDate: '20240710' };

describe('formatBaseDate', () => {
  it('yyyymmdd を帳票の表示形式(YYYY年M月D日)へ整える', () => {
    expect(formatBaseDate('20240710')).toBe('2024年7月10日');
    expect(formatBaseDate('20261231')).toBe('2026年12月31日');
    // 月日の先頭ゼロは落とす(sampleCommon の他の日付と同じ書きぶり)。
    expect(formatBaseDate('20260101')).toBe('2026年1月1日');
  });

  it('8 桁数字でない値は壊さずそのまま返す(規約外の残存資産を表示で破壊しない)', () => {
    expect(formatBaseDate('2024-07-10')).toBe('2024-07-10');
    expect(formatBaseDate('')).toBe('');
  });
});

describe('applyTemplateAttributes', () => {
  it('report へ版種と整形済み基準日を被せ、他のキーは保つ', () => {
    const sample: SampleData = { report: { term: '第1期' }, fund: { name: 'X' } };
    const out = applyTemplateAttributes(sample, ATTRS);
    expect(out.report).toEqual({
      term: '第1期',
      editionType: '交付版',
      baseDate: '2024年7月10日',
    });
    expect(out.fund).toEqual({ name: 'X' });
    // 元のオブジェクトは変異させない(sample は共有されうる)。
    expect(sample.report).toEqual({ term: '第1期' });
  });

  it('report が無いサンプルにも被せられる', () => {
    const out = applyTemplateAttributes({}, ATTRS);
    expect(out.report).toEqual({ editionType: '交付版', baseDate: '2024年7月10日' });
  });
});

describe('buildSampleData のテンプレ属性上書き', () => {
  it('attributes を渡すと共通ダミーの report を版種・基準日で上書きする', () => {
    const out = buildSampleData(undefined, '510037', ATTRS);
    const report = out.report as Record<string, unknown>;
    expect(report.editionType).toBe('交付版');
    expect(report.baseDate).toBe('2024年7月10日');
    expect((out.fund as Record<string, unknown>).code).toBe('510037');
  });

  it('attributes 無しでは従来どおり共通ダミーのまま(呼び出し互換)', () => {
    const out = buildSampleData(undefined, '510037');
    expect((out.report as Record<string, unknown>).editionType).toBe(
      (sampleCommon.report as Record<string, unknown>).editionType,
    );
  });

  it('fund.navChange は number(テンプレの符号分岐 `>= 0` が動く型)', () => {
    const out = buildSampleData(undefined, '510037');
    expect(typeof (out.fund as Record<string, unknown>).navChange).toBe('number');
  });
});
