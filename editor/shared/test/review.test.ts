// =============================================================================
// review.test.ts — 承認ワークフローのスキーマ拡張(保留・変更概要)の検証
// =============================================================================
import { describe, expect, it } from 'vitest';
import { duplicateReviewMessage, formatDateTimeYmdHm } from '../src/domain/review.js';
import {
  MAX_REVIEW_PART_KEY_CHARS,
  ReviewRequestMeta,
  ReviewStatus,
  SubmitReviewBody,
  UpdateReviewPartDecisionsRequest,
} from '../src/schemas.js';

const baseMeta = {
  id: 'rv1',
  templateId: 'XX01_950037_20240710_交付版',
  attributes: {
    companyCode: 'XX01',
    fundCode: '950037',
    baseDate: '20240710',
    editionType: '交付版',
  },
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
      templateId: 'XX01_950037_20240710_交付版',
      html: '<p>x</p>',
      css: '',
      origin: 'edit',
    };
    expect(SubmitReviewBody.parse(body).changedSummary).toBeUndefined();
    expect(() =>
      SubmitReviewBody.parse({ ...body, changedSummary: { count: -1, names: [] } }),
    ).toThrow();
  });
});

describe('formatDateTimeYmdHm / duplicateReviewMessage', () => {
  it('現地時刻のゼロ埋め YYYY/MM/DD HH:mm にする', () => {
    const d = new Date(2026, 0, 2, 3, 4);
    expect(formatDateTimeYmdHm(d.toISOString())).toBe('2026/01/02 03:04');
  });

  it('重複申請の文言は申請日時と「作りませんでした」を含む', () => {
    const d = new Date(2026, 11, 31, 23, 59);
    expect(duplicateReviewMessage(d.toISOString())).toBe(
      '同じ内容の確定保存申請が既に承認待ちです（2026/12/31 23:59に申請）。新しい申請は作りませんでした。',
    );
  });
});

describe('UpdateReviewPartDecisionsRequest', () => {
  const ok = (decisions: unknown) =>
    UpdateReviewPartDecisionsRequest.safeParse({ decisions }).success;

  it('承認・却下・取り消しを 1 回で受ける', () => {
    expect(
      ok([
        { partKey: 'a#0', status: 'approved' },
        { partKey: 'b#1', status: 'rejected', comment: '数値が違う' },
        { partKey: 'c#2', status: 'pending' },
      ]),
    ).toBe(true);
  });
  it('却下は理由が要る', () => {
    expect(ok([{ partKey: 'a#0', status: 'rejected' }])).toBe(false);
  });
  it('空白だけの却下理由は拒む', () => {
    expect(ok([{ partKey: 'a#0', status: 'rejected', comment: ' 　\n' }])).toBe(false);
  });
  it('同じ partKey が 2 つあれば拒む', () => {
    const r = UpdateReviewPartDecisionsRequest.safeParse({
      decisions: [
        { partKey: 'a#0', status: 'approved' },
        { partKey: 'a#0', status: 'pending' },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('partKey が重複しています: a#0');
  });
  it('空の配列は拒む', () => {
    expect(ok([])).toBe(false);
  });
  it('5,001 件は拒む', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ partKey: `k#${i}`, status: 'approved' }));
    expect(ok(mk(5000))).toBe(true);
    expect(ok(mk(5001))).toBe(false);
  });
  it('partKey は MAX_REVIEW_PART_KEY_CHARS(512)文字まで。どの status でも長すぎれば拒む', () => {
    expect(MAX_REVIEW_PART_KEY_CHARS).toBe(512);
    for (const d of [
      { status: 'approved' },
      { status: 'rejected', comment: '理由' },
      { status: 'pending' },
    ]) {
      expect(ok([{ ...d, partKey: 'k'.repeat(512) }])).toBe(true);
      expect(ok([{ ...d, partKey: 'k'.repeat(513) }])).toBe(false);
    }
  });
  it('長すぎる却下の理由は拒む', () => {
    const rej = (comment: string) => ok([{ partKey: 'a#0', status: 'rejected', comment }]);
    expect(rej('あ'.repeat(2000))).toBe(true);
    expect(rej('あ'.repeat(2001))).toBe(false);
    // 😀 は 1 コードポイント = 2 UTF-16 単位。1000 個で 2000 単位、1001 個で 2002 単位
    expect(rej('😀'.repeat(1000))).toBe(true);
    expect(rej('😀'.repeat(1001))).toBe(false);
  });
  it('承認は判定メモを持てない(余分なキーは無視され、出力に残らない)', () => {
    const r = UpdateReviewPartDecisionsRequest.parse({
      decisions: [{ partKey: 'a#0', status: 'approved', comment: 'メモ' }],
    });
    expect(r.decisions[0]).toEqual({ partKey: 'a#0', status: 'approved' });
  });
});
