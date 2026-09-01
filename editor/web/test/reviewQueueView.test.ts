// =============================================================================
// reviewQueueView.test.ts — 承認キュー一覧のサマリ・保留・変更概要表示
// =============================================================================
// repo(`useReviewRepo`)と `useAuthStore` をモックして mount する。router は
// `useRouter` を直接モックする(`BackButton.test.ts` と同じ流儀。ReviewQueueView は
// push しか使わないため実 router を組み立てる必要が無い)。
import { ok, type ReviewRequestMeta } from '@editor/shared';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewQueueView from '@/features/reviews/ReviewQueueView.vue';

const listReviewsFn = vi.fn();
const push = vi.fn();

vi.mock('@/api/repositories', () => ({
  useReviewRepo: () => ({ listReviews: listReviewsFn }),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));

const isApprover = { value: true };
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isApprover }),
}));

beforeEach(() => {
  listReviewsFn.mockReset();
  push.mockClear();
  isApprover.value = true;
});

/** Task 1 の `review.test.ts` の `baseMeta` と同形。patch を被せて 1 件分を作る。 */
function meta(patch: Partial<ReviewRequestMeta>): ReviewRequestMeta {
  return {
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
    ...patch,
  };
}

/** repo が返す一覧を差し替えて mount し、サマリ箱をクリックしたければ第 2 引数で指定する。 */
async function mountQueue(metas: ReviewRequestMeta[], clickSummary?: string) {
  listReviewsFn.mockResolvedValue(ok(metas));
  const w = mount(ReviewQueueView, {
    global: { stubs: { FundCodeName: true } },
  });
  await flushAll();
  if (clickSummary) {
    const box = w.findAll('[data-summary-box]').find((b) => b.text().includes(clickSummary));
    await box?.trigger('click');
    await flushAll();
  }
  return w;
}

/** onMounted の load() は非同期。イベントループを 1 周させて反映を待つ。 */
async function flushAll() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ReviewQueueView', () => {
  it('サマリ 4 箱に全状態の件数を出す', async () => {
    const metas = [
      meta({ id: 'a', status: 'pending', changedSummary: { count: 2, names: ['運用実績の表'] } }),
      meta({ id: 'b', status: 'held', holdComment: '出所確認中' }),
      meta({ id: 'c', status: 'approved' }),
      meta({ id: 'd', status: 'rejected' }),
    ];
    const w = await mountQueue(metas);
    const boxes = w.findAll('[data-summary-box]');
    expect(boxes).toHaveLength(4);
    expect(boxes[0].text()).toContain('1'); // 承認待ち
    expect(boxes[1].text()).toContain('1'); // 保留中
  });

  it('カードに変更概要(自己申告)を参考表示する', async () => {
    const metas = [
      meta({ id: 'a', status: 'pending', changedSummary: { count: 2, names: ['運用実績の表'] } }),
    ];
    const w = await mountQueue(metas);
    expect(w.text()).toContain('変更 2 か所');
    expect(w.text()).toContain('運用実績の表');
  });

  it('保留カードに保留メモと「確認を再開する」を出す', async () => {
    const metas = [
      meta({ id: 'a', status: 'pending' }),
      meta({ id: 'b', status: 'held', holdComment: '出所確認中' }),
    ];
    const w = await mountQueue(metas, '保留中');
    expect(w.text()).toContain('出所確認中');
    expect(w.text()).toContain('確認を再開する');
  });

  it('「精査する」の文言を出さない', async () => {
    const metas = [meta({ id: 'a', status: 'pending' })];
    const w = await mountQueue(metas);
    expect(w.text()).not.toContain('精査する');
    expect(w.text()).toContain('内容を確認する');
  });

  it('ステータス表示は「却下」でなく「差し戻し」「承認済み」で統一する', async () => {
    const metas = [
      meta({
        id: 'a',
        status: 'approved',
        reviewedBy: 'approver1',
        reviewedAt: '2026-08-27T01:00:00.000Z',
      }),
      meta({
        id: 'b',
        status: 'rejected',
        reviewedBy: 'approver1',
        reviewedAt: '2026-08-27T01:00:00.000Z',
      }),
    ];
    const w = await mountQueue(metas);
    expect(w.text()).not.toContain('却下');
    expect(w.text()).toContain('承認済み');
    expect(w.text()).toContain('差し戻し');
  });

  // カードは `flex-wrap` の 1 行で、全幅(`w-full`)の子はそこで行を折り返す。折り返す子より
  // 後ろに置いた要素は次の行へ送られるため、補足行は必ず最後に置く(前に置くと申請者情報と
  // ボタンが 3 行目へ落ちる)。
  it('全幅の補足行はカードの最後の子に置く', async () => {
    const metas = [
      meta({ id: 'a', status: 'pending', changedSummary: { count: 2, names: ['運用実績の表'] } }),
    ];
    const w = await mountQueue(metas);
    const children = Array.from(w.findAll('li')[0].element.children);
    const fullWidth = children.findIndex((el) => el.classList.contains('w-full'));
    expect(fullWidth).toBe(children.length - 1);
  });

  it('変更概要も保留メモも無いカードは空の補足行を描画しない', async () => {
    const metas = [meta({ id: 'a', status: 'pending' })];
    const w = await mountQueue(metas);
    const children = Array.from(w.findAll('li')[0].element.children);
    expect(children.some((el) => el.classList.contains('w-full'))).toBe(false);
  });
});
