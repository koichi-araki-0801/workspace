import { appError, err, ok, type ReviewPartDecision, type ReviewRequest } from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useReviewDecisions } from '@/features/reviews/useReviewDecisions';

const toastFn = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: (...a: unknown[]) => toastFn(...a) }));

const dec = (k: string, status: string): ReviewPartDecision =>
  ({ partKey: k, status }) as ReviewPartDecision;

function setup(saveResult: unknown) {
  const save = vi.fn().mockResolvedValue(saveResult);
  const reload = vi.fn().mockResolvedValue(undefined);
  const review = ref({ partDecisions: [dec('a#1', 'rejected')] } as unknown as ReviewRequest);
  const d = useReviewDecisions({
    review,
    diff: ref(null),
    changes: ref([
      { no: 1, partKey: 'a#1' },
      { no: 2, partKey: 'b#1' },
    ] as never),
    save,
    reload,
  });
  return { d, save, reload };
}

beforeEach(() => toastFn.mockReset());

describe('useReviewDecisions', () => {
  it('まとめて承認は 1 回の要求で送り、応答で手元の判定を差し替え、読み直さない', async () => {
    const { d, save, reload } = setup(ok([dec('a#1', 'approved'), dec('b#1', 'approved')]));
    expect(await d.approve(['a#1', 'b#1'])).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      decisions: [
        { partKey: 'a#1', status: 'approved' },
        { partKey: 'b#1', status: 'approved' },
      ],
    });
    expect(d.counts.value.approved).toBe(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('却下は全パーツへ同じ理由を付けて 1 回で送る', async () => {
    const { d, save } = setup(ok([dec('a#1', 'rejected'), dec('b#1', 'rejected')]));
    await d.reject(['a#1', 'b#1'], '誤り');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      decisions: [
        { partKey: 'a#1', status: 'rejected', comment: '誤り' },
        { partKey: 'b#1', status: 'rejected', comment: '誤り' },
      ],
    });
  });

  it('取り消しで返る pending を保持し、未判定と読む', async () => {
    const { d } = setup(ok([dec('a#1', 'pending')]));
    await d.undo('a#1');
    expect(d.decisions.value).toEqual([dec('a#1', 'pending')]);
    expect(d.counts.value.pending).toBe(2);
  });

  it('code が REVIEW_PART_DECISION_TRANSITION の 409 は読み直し、「ほかの方が判定を変えました。画面を読み直しました。」を出す', async () => {
    const { d, reload } = setup(
      err(appError('conflict', 'x', { code: 'REVIEW_PART_DECISION_TRANSITION' })),
    );
    expect(await d.approve(['a#1'])).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastFn).toHaveBeenCalledWith(
      'ほかの方が判定を変えました。画面を読み直しました。',
      'error',
    );
  });

  it('code が REVIEW_ALREADY_DECIDED の 409 は読み直し、「この申請はすでに処理されています。画面を読み直しました。」を出す', async () => {
    const { d, reload } = setup(err(appError('conflict', 'x', { code: 'REVIEW_ALREADY_DECIDED' })));
    expect(await d.approve(['a#1'])).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastFn).toHaveBeenCalledWith(
      'この申請はすでに処理されています。画面を読み直しました。',
      'error',
    );
  });

  it('code の無い 409 は保存の失敗として扱う', async () => {
    const { d, reload } = setup(err(appError('conflict', 'x')));
    expect(await d.approve(['a#1'])).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastFn).toHaveBeenCalledWith('パーツ判定の保存に失敗しました。', 'error');
  });

  it('失敗のときは読み直し、「パーツ判定の保存に失敗しました。」を出す', async () => {
    const { d, reload } = setup(err(appError('unexpected', 'x')));
    expect(await d.reject(['a#1'], 'r')).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastFn).toHaveBeenCalledWith('パーツ判定の保存に失敗しました。', 'error');
  });

  it('diff が無ければ判定の過不足は空、あれば最終候補から出す', () => {
    const base = {
      review: ref(null),
      changes: ref([]),
      save: vi.fn(),
      reload: vi.fn(),
    };
    const none = useReviewDecisions({ ...base, diff: ref(null) });
    expect(none.pendingPartKeys.value).toEqual([]);
    expect(none.unknownDecisionPartKeys.value).toEqual([]);
    expect(none.duplicateDecisionPartKeys.value).toEqual([]);

    const diff = { pages: [], afterPageCount: 0, beforePageCount: 0 } as never;
    const some = useReviewDecisions({
      ...base,
      review: ref({ partDecisions: [dec('x#1', 'approved')] } as never),
      diff: ref(diff),
    });
    expect(some.unknownDecisionPartKeys.value).toEqual(['x#1']);
    expect(some.pendingPartKeys.value).toEqual([]);
    expect(some.duplicateDecisionPartKeys.value).toEqual([]);
  });
});
