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
  it('pending / approved / rejected の 3 値だけを受理する', () => {
    expect(ReviewStatus.parse('pending')).toBe('pending');
    expect(ReviewStatus.safeParse('held').success).toBe(false);
  });
});

describe('ReviewRequestMeta', () => {
  it('変更概要を保持し、保留フィールドは契約に無い', () => {
    const meta = ReviewRequestMeta.parse({
      ...baseMeta,
      changedSummary: { count: 2, names: ['運用実績の表', 'ご挨拶文'] },
    });
    expect(meta.changedSummary?.names).toHaveLength(2);
    expect('heldBy' in ReviewRequestMeta.shape).toBe(false);
  });

  it('レガシー meta(新フィールド無し)も受理する', () => {
    const meta = ReviewRequestMeta.parse(baseMeta);
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
