import {
  err,
  ok,
  type ReviewPartDecision,
  type ReviewRepository,
  type ReviewRequest,
  type ReviewRequestMeta,
} from '@editor/shared';
import { describe, expect, it, vi } from 'vitest';
import { useRejectedReasons } from '@/features/editor/useRejectedReasons';

const TID = 'XX01_950037_20240710_交付版';

function rejected(partKey: string, reason: string): ReviewPartDecision {
  return {
    partKey,
    status: 'rejected',
    decidedBy: '承認 太郎',
    decidedAt: '2026-10-28T01:02:00.000Z',
    comment: reason,
    history: [],
  };
}

function meta(p: Partial<ReviewRequestMeta> & { id: string }): ReviewRequestMeta {
  return {
    templateId: TID,
    attributes: {} as ReviewRequestMeta['attributes'],
    origin: 'edit',
    status: 'approved',
    submittedBy: 'me',
    submittedAt: '2026-10-28T00:00:00.000Z',
    reviewedBy: '承認 太郎',
    reviewedAt: '2026-10-28T01:00:00.000Z',
    comment: null,
    baseHash: null,
    partDecisions: [],
    ...p,
  };
}

function repo(list: ReviewRequestMeta[] | 'fail', body?: Partial<ReviewRequest>) {
  const listReviews = vi.fn(async () =>
    list === 'fail' ? err({ kind: 'network', message: 'x' } as never) : ok(list),
  );
  const getReview = vi.fn(async (id: string) =>
    ok({ ...meta({ id }), html: '', css: '', ...body } as ReviewRequest),
  );
  return { listReviews, getReview } as unknown as ReviewRepository & {
    listReviews: typeof listReviews;
    getReview: typeof getReview;
  };
}

function setup(
  reviews: ReviewRepository,
  canvasKeys: string[] = ['p#1'],
  me: string | null = 'me',
) {
  return useRejectedReasons({
    templateId: TID,
    me: () => me,
    reviews,
    canvasKeys: () => new Set(canvasKeys),
  });
}

describe('useRejectedReasons', () => {
  it('自分の最新の申請が決着済みで却下があれば、却下したパーツの理由を返す', async () => {
    const reviews = repo([
      meta({
        id: 'old',
        submittedAt: '2026-10-01T00:00:00.000Z',
        partDecisions: [rejected('p#1', '古い')],
      }),
      meta({
        id: 'new',
        partDecisions: [
          rejected('p#1', '数値が違う'),
          { ...rejected('q#1', 'x'), status: 'approved', comment: null } as ReviewPartDecision,
        ],
      }),
    ]);
    const r = setup(reviews);
    await r.reload();
    expect([...r.reasons.value.values()]).toEqual([
      {
        partKey: 'p#1',
        reason: '数値が違う',
        decidedBy: '承認 太郎',
        decidedAt: '2026-10-28T01:02:00.000Z',
        name: null,
      },
    ]);
    expect(reviews.getReview).not.toHaveBeenCalled();
  });

  it('最新の申請が承認待ちなら空', async () => {
    const r = setup(
      repo([
        meta({
          id: 'old',
          submittedAt: '2026-10-01T00:00:00.000Z',
          partDecisions: [rejected('p#1', '理由')],
        }),
        meta({ id: 'new', status: 'pending', reviewedBy: null, reviewedAt: null }),
      ]),
    );
    await r.reload();
    expect(r.reasons.value.size).toBe(0);
  });

  it('他人の申請・別テンプレートの申請は見ない', async () => {
    const r = setup(
      repo([
        meta({
          id: 'a',
          partDecisions: [rejected('p#1', '自分の')],
          submittedAt: '2026-10-01T00:00:00.000Z',
        }),
        meta({ id: 'b', submittedBy: 'other', partDecisions: [rejected('p#1', '他人の')] }),
        meta({ id: 'c', templateId: 'YY', partDecisions: [rejected('p#1', '別テンプレ')] }),
      ]),
    );
    await r.reload();
    expect(r.reasons.value.get('p#1')?.reason).toBe('自分の');
  });

  it('利用者が分からなければ空で、一覧も取らない', async () => {
    const reviews = repo([meta({ id: 'a', partDecisions: [rejected('p#1', '理由')] })]);
    const r = setup(reviews, ['p#1'], null);
    await r.reload();
    expect(r.reasons.value.size).toBe(0);
    expect(reviews.listReviews).not.toHaveBeenCalled();
  });

  it('canvas に無いキーだけ getReview で名前を作る', async () => {
    const reviews = repo(
      [meta({ id: 'r1', partDecisions: [rejected('p#1', '既存'), rejected('p#2', '追加')] })],
      {
        html: '<p>使わない</p>',
        filledHtml: '<p>一つ目</p><p>二つ目の段落</p>',
      },
    );
    const r = setup(reviews, ['p#1']);
    await r.reload();
    expect(reviews.getReview).toHaveBeenCalledTimes(1);
    expect(reviews.getReview).toHaveBeenCalledWith('r1');
    expect(r.reasons.value.get('p#1')?.name).toBeNull();
    expect(r.reasons.value.get('p#2')?.name).toBe('二つ目の段落');
  });

  it('本文の取得に失敗したら名前は null のまま理由を返す', async () => {
    const reviews = repo([meta({ id: 'r1', partDecisions: [rejected('p#9', '理由')] })]);
    reviews.getReview.mockResolvedValueOnce(err({ kind: 'network', message: 'x' } as never));
    const r = setup(reviews, ['p#1']);
    await r.reload();
    expect(r.reasons.value.get('p#9')).toMatchObject({ reason: '理由', name: null });
  });

  it('一覧の取得に失敗したら空で、例外を投げない', async () => {
    const r = setup(repo('fail'));
    await expect(r.reload()).resolves.toBeUndefined();
    expect(r.reasons.value.size).toBe(0);
  });

  it('申請ごと却下(status rejected で partDecisions に却下が無い)は何も出さない', async () => {
    const r = setup(
      repo([
        meta({ id: 'r1', status: 'rejected', comment: '申請ごと却下の理由', partDecisions: [] }),
      ]),
    );
    await r.reload();
    expect(r.reasons.value.size).toBe(0);
  });
});
