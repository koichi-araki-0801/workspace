// =============================================================================
// useReviewDiff.test.ts — 承認画面のデータ取得/承認/却下 composable の単体テスト (vitest)
// =============================================================================
// diffService(`buildDiff`)と reviewRepo(`approveReview`/`rejectReview`)をモックし、
// 「load 成功で状態反映」「load 失敗で loadError」「承認/却下の repo 呼び出し」を固定する。
// composable はライフサイクル非依存(useAsyncResult も同様)なので直接呼び出して検証できる。
import { err, notFound, ok } from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReviewDiff } from '@/features/reviews/useReviewDiff';

const buildDiff = vi.fn();
const approveReviewFn = vi.fn();
const rejectReviewFn = vi.fn();

vi.mock('@/features/reviews/services/reviewDiffService', () => ({
  useReviewDiffService: () => ({ buildDiff }),
}));
vi.mock('@/api/repositories', () => ({
  useReviewRepo: () => ({
    approveReview: approveReviewFn,
    rejectReview: rejectReviewFn,
  }),
}));

const diffData = {
  review: { id: 'r1', origin: 'edit' },
  rows: [{ key: 'k', label: 'p', status: 'changed', beforeHtml: 'a', afterHtml: 'b' }],
  summary: { total: 1, changed: 1, added: 0, removed: 0 },
  cssBefore: '.b{}',
  cssAfter: '.a{}',
  beforeBodyHtml: '<p>before</p>',
  afterBodyHtml: '<p>after</p>',
  changedPageIndexes: [0],
};

beforeEach(() => {
  buildDiff.mockReset();
  approveReviewFn.mockReset();
  rejectReviewFn.mockReset();
});

describe('useReviewDiff', () => {
  it('load 成功で申請・行・集計・CSS を状態へ載せる', async () => {
    buildDiff.mockResolvedValue(ok(diffData));
    const d = useReviewDiff(() => 'r1');
    await d.load();

    expect(buildDiff).toHaveBeenCalledWith('r1');
    expect(d.review.value?.id).toBe('r1');
    expect(d.rows.value).toHaveLength(1);
    expect(d.summary.value.changed).toBe(1);
    expect(d.cssBefore.value).toBe('.b{}');
    expect(d.cssAfter.value).toBe('.a{}');
    expect(d.beforeBodyHtml.value).toBe('<p>before</p>');
    expect(d.afterBodyHtml.value).toBe('<p>after</p>');
    expect(d.changedPageIndexes.value).toEqual([0]);
    expect(d.loadError.value).toBe(false);
    expect(d.loading.value).toBe(false);
  });

  it('load 失敗で loadError を立て、状態は初期のまま', async () => {
    buildDiff.mockResolvedValue(err(notFound('no request')));
    const d = useReviewDiff(() => 'rX');
    await d.load();

    expect(d.loadError.value).toBe(true);
    expect(d.review.value).toBeNull();
  });

  it('approve は reqId とコメントで repo を呼び、結果を返す', async () => {
    approveReviewFn.mockResolvedValue(ok({ meta: { id: 'r1' }, staleWarning: false }));
    const d = useReviewDiff(() => 'r1');
    const res = await d.approve('ok');

    expect(approveReviewFn).toHaveBeenCalledWith('r1', { comment: 'ok' });
    expect(res.ok).toBe(true);
  });

  it('reject は reqId とコメントで repo を呼ぶ', async () => {
    rejectReviewFn.mockResolvedValue(ok({ id: 'r1', status: 'rejected' }));
    const d = useReviewDiff(() => 'r1');
    await d.reject('NG');

    expect(rejectReviewFn).toHaveBeenCalledWith('r1', { comment: 'NG' });
  });
});
