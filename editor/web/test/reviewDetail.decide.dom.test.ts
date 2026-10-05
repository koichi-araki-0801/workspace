// =============================================================================
// reviewDetail.decide.dom.test.ts — 申請 1 件の決着の伝え方と、PDF を開くときの描画の要否
// =============================================================================
// 決着後の読み直し(`load`)は失敗しうる。失敗しても承認・却下は成立しているので、親へは決着後の
// 状態を伝える(承認待ちのまま伝えると、一覧に決着済みの申請が承認待ちとして残る)。
// 記入済みインスタンスが無い申請の PDF は diff 由来の申請版本文から作る。これは描画済みの
// HTML なので、もう一度 Jinja に通すと `{{` に見える文字が消える。
import {
  type ApproveReviewResult,
  ok,
  type Result,
  type ReviewRequest,
  type ReviewRequestMeta,
} from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import ReviewDetail from '@/features/reviews/ReviewDetail.vue';

const { state, renderPdf } = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  renderPdf: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => reactive({ isApprover: true, user: { username: 'boss' } }),
}));
vi.mock('@/features/preview/services/templatePreviewService', () => ({
  useTemplatePreviewService: () => ({ renderPdf }),
}));
vi.mock('@/features/reviews/useReviewDiff', () => ({ useReviewDiff: () => state }));

const pendingReview: ReviewRequest = {
  id: 'r1',
  templateId: 'AM01_510037_20240710_交付版',
  attributes: {
    companyCode: 'AM01',
    fundCode: '510037',
    baseDate: '20240710',
    editionType: '交付版',
  },
  origin: 'edit',
  status: 'pending',
  submittedBy: 'editor1',
  submittedAt: '2026-10-01T00:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  comment: null,
  baseHash: null,
  html: '<p>{{ x }}</p>',
  css: '',
  filledHtml: '',
};

function setupState(opts: { reloadFails: boolean }) {
  const review = ref<ReviewRequest | null>({ ...pendingReview });
  const loadError = ref(false);
  let loads = 0;
  Object.assign(state, {
    review,
    rows: ref([]),
    summary: ref({ total: 0, changed: 0, added: 0, removed: 0 }),
    cssBefore: ref(''),
    cssAfter: ref('.a{}'),
    beforeBodyHtml: ref(''),
    afterBodyHtml: ref('<p>{{ 描画済みの本文 }}</p>'),
    changedPageIndexes: ref([]),
    beforePageCount: ref(1),
    afterPageCount: ref(1),
    truncated: ref(false),
    cssChanged: ref(false),
    printOnlyCss: ref(false),
    loadError,
    loading: ref(false),
    deciding: ref(false),
    load: vi.fn(async () => {
      loads += 1;
      // 初回(マウント時)は成功、決着後の読み直しだけを失敗させる。
      if (loads > 1 && opts.reloadFails) loadError.value = true;
    }),
    approve: vi.fn(
      async (): Promise<Result<ApproveReviewResult>> =>
        ok({ meta: {} as ApproveReviewResult['meta'], staleWarning: false }),
    ),
    reject: vi.fn(
      async (comment?: string): Promise<Result<ReviewRequestMeta>> =>
        ok({
          ...pendingReview,
          status: 'rejected',
          reviewedBy: 'boss',
          reviewedAt: '2026-10-02T00:00:00.000Z',
          comment: comment ?? null,
        }),
    ),
  });
}

function mountDetail() {
  return mount(ReviewDetail, {
    props: { reqId: 'r1' },
    global: {
      stubs: { ReviewVisualCompare: true, ReviewNoticeBar: true },
    },
  });
}

const buttonNamed = (w: ReturnType<typeof mountDetail>, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text));

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k];
  renderPdf.mockReset();
});

describe('ReviewDetail の決着', () => {
  it('承認後の読み直しに失敗しても、承認済みとして親へ伝える', async () => {
    setupState({ reloadFails: true });
    const w = mountDetail();
    await flushPromises();
    await buttonNamed(w, '承認する')?.trigger('click');
    await flushPromises();
    const decided = w.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided?.id).toBe('r1');
    expect(decided?.status).toBe('approved');
  });

  it('却下後の読み直しに失敗しても、却下の応答を親へ伝える', async () => {
    setupState({ reloadFails: true });
    const w = mountDetail();
    await flushPromises();
    await w.find('textarea').setValue('理由');
    await buttonNamed(w, '却下する')?.trigger('click');
    await flushPromises();
    const decided = w.emitted('decided')?.at(-1)?.[0] as ReviewRequestMeta | undefined;
    expect(decided?.status).toBe('rejected');
    expect(decided?.comment).toBe('理由');
    expect(decided).not.toHaveProperty('html');
  });
});

describe('ReviewDetail の PDF', () => {
  it('記入済みインスタンスが無ければ、描画済みの申請版本文を描画に通さず PDF にする', async () => {
    setupState({ reloadFails: false });
    renderPdf.mockResolvedValue(ok(new Blob(['%PDF'])));
    const w = mountDetail();
    await flushPromises();
    // URL.createObjectURL は jsdom に無い。
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    w.findComponent({ name: 'ReviewNoticeBar' }).vm.$emit('open-pdf');
    await flushPromises();
    expect(renderPdf).toHaveBeenCalledTimes(1);
    const [html, , , , skipJinja] = renderPdf.mock.calls[0] as unknown[];
    expect(html).toBe('<p>{{ 描画済みの本文 }}</p>');
    expect(skipJinja).toBe(true);
  });
});
