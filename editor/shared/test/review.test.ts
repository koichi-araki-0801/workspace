// =============================================================================
// review.test.ts — 承認ワークフローのスキーマ拡張(保留・変更概要)の検証
// =============================================================================
import { describe, expect, it } from 'vitest';
import { ReviewRequestMeta, ReviewStatus, SubmitReviewBody } from '../src/schemas.js';

const baseMeta = {
  id: 'rv1',
  templateId: 'AM01_510037_20240710_交付版',
  attributes: {
    companyCode: 'AM01',
    fundCode: '510037',
    baseDate: '20240710',
    editionType: '交付版',
  },
  fundCode: '510037',
  origin: 'edit',
  status: 'pending',
  submittedBy: 'editor1',
  submittedAt: '2026-08-27T00:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  comment: null,
  baseHash: null,
};

describe('ReviewStatus', () => {
  it('held を受理する', () => {
    expect(ReviewStatus.parse('held')).toBe('held');
  });
});

describe('ReviewRequestMeta', () => {
  it('保留フィールドと変更概要を保持する', () => {
    const meta = ReviewRequestMeta.parse({
      ...baseMeta,
      status: 'held',
      heldBy: 'approver1',
      heldAt: '2026-08-27T01:00:00.000Z',
      holdComment: '数値の出所を確認中',
      changedSummary: { count: 2, names: ['運用実績の表', 'ご挨拶文'] },
    });
    expect(meta.heldBy).toBe('approver1');
    expect(meta.changedSummary?.names).toHaveLength(2);
  });

  it('レガシー meta(新フィールド無し)も受理する', () => {
    const meta = ReviewRequestMeta.parse(baseMeta);
    expect(meta.heldBy ?? null).toBeNull();
    expect(meta.changedSummary ?? null).toBeNull();
  });
});

describe('SubmitReviewBody', () => {
  it('changedSummary は任意で、件数は非負整数のみ', () => {
    const body = {
      templateId: 'AM01_510037_20240710_交付版',
      html: '<p>x</p>',
      css: '',
      fundCode: '510037',
      origin: 'edit',
    };
    expect(SubmitReviewBody.parse(body).changedSummary).toBeUndefined();
    expect(() =>
      SubmitReviewBody.parse({ ...body, changedSummary: { count: -1, names: [] } }),
    ).toThrow();
  });
});
