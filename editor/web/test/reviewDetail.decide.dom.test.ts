// =============================================================================
// reviewDetail.decide.dom.test.ts — 申請 1 件の決着の伝え方と、PDF を開くときの描画の要否
// =============================================================================
// 決着後の読み直し(`load`)は失敗しうる。失敗しても承認・却下は成立しているので、親へは決着後の
// 状態を伝える(承認待ちのまま伝えると、一覧に決着済みの申請が承認待ちとして残る)。
// 記入済みインスタンスが無い申請の PDF は diff 由来の申請版本文から作る。これは描画済みの
// HTML なので、もう一度 Jinja に通すと `{{` に見える文字が消える。
// 下部の決着箱は最終確定(「最終確定する」)を持ち、未判定の変更パーツが残る間はタブに関係なく
// 一括承認もそこから押せる(パーツ行の「承認する」とは名前で区別する)。
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
import { confirm } from '@/components/ui/confirm';
import ReviewDetail from '@/features/reviews/ReviewDetail.vue';

const { state, renderPdf } = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  renderPdf: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({ toast: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/components/ui/confirm', () => ({ confirm: vi.fn(async () => true) }));

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => reactive({ isApprover: true, user: { username: 'boss' } }),
}));
vi.mock('@/features/preview/services/templatePreviewService', () => ({
  useTemplatePreviewService: () => ({ renderPdf }),
}));
vi.mock('@/features/reviews/useReviewDiff', () => ({ useReviewDiff: () => state }));

const pendingReview: ReviewRequest = {
  id: 'r1',
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
  submittedAt: '2026-10-01T00:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  comment: null,
  baseHash: null,
  html: '<p>{{ x }}</p>',
  css: '',
  filledHtml: '',
};

/** 判定対象の変更パーツ 1 行(表示に要る項目だけ)。 */
const changedRow = {
  key: 'p1',
  label: 'ページ1・パーツ1',
  status: 'changed',
  beforeHtml: '',
  afterHtml: '',
  rawBeforeHtml: '',
  rawAfterHtml: '',
  textOps: [],
};

function setupState(opts: {
  reloadFails: boolean;
  pendingRows?: boolean;
  truncated?: boolean;
  duplicates?: string[];
  review?: Partial<ReviewRequest>;
}) {
  const review = ref<ReviewRequest | null>({ ...pendingReview, ...opts.review });
  const loadError = ref(false);
  let loads = 0;
  Object.assign(state, {
    review,
    rows: ref(opts.pendingRows ? [changedRow] : []),
    summary: ref(
      opts.pendingRows
        ? { total: 1, changed: 1, added: 0, removed: 0 }
        : { total: 0, changed: 0, added: 0, removed: 0 },
    ),
    cssBefore: ref(''),
    cssAfter: ref('.a{}'),
    beforeBodyHtml: ref(''),
    reviewedBodyHtml: ref('<p>{{ 描画済みの本文 }}</p>'),
    pendingPartKeys: ref(opts.pendingRows ? [changedRow.key] : []),
    unknownDecisionPartKeys: ref([]),
    duplicateDecisionPartKeys: ref(opts.duplicates ?? []),
    updatePartDecision: vi.fn(async (input: { partKey: string; status: string }) =>
      ok({
        partKey: input.partKey,
        status: input.status,
        comment: null,
        decidedBy: 'boss',
        decidedAt: '2026-10-02T00:00:00.000Z',
        history: [],
      }),
    ),
    afterBodyHtml: ref('<p>{{ 描画済みの本文 }}</p>'),
    changedPageIndexes: ref([]),
    beforePageCount: ref(1),
    afterPageCount: ref(1),
    truncated: ref(opts.truncated ?? false),
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
const buttonsNamed = (w: ReturnType<typeof mountDetail>, text: string) =>
  w.findAll('button').filter((b) => b.text().includes(text));
/** 下部の決着箱(却下理由の入力欄を持つ箱)。 */
const decisionBox = (w: ReturnType<typeof mountDetail>) => w.find('[data-review-decision]');

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k];
  renderPdf.mockReset();
});

describe('ReviewDetail の決着', () => {
  it('承認後の読み直しに失敗しても、承認済みとして親へ伝える', async () => {
    setupState({ reloadFails: true });
    const w = mountDetail();
    await flushPromises();
    await buttonNamed(w, '最終確定する')?.trigger('click');
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

describe('ReviewDetail の決着箱', () => {
  it('最終確定のボタンは「最終確定する」で、「承認する」とは名乗らない', async () => {
    setupState({ reloadFails: false });
    const w = mountDetail();
    await flushPromises();
    const box = decisionBox(w);
    expect(box.exists()).toBe(true);
    const labels = box.findAll('button').map((b) => b.text());
    expect(labels).toContain('最終確定する');
    expect(labels.some((t) => t.includes('承認する'))).toBe(false);
  });

  it('未判定の変更パーツがあれば、見た目比較タブでも決着箱に一括承認が出る', async () => {
    setupState({ reloadFails: false, pendingRows: true });
    const w = mountDetail();
    await flushPromises();
    const bulk = decisionBox(w)
      .findAll('button')
      .find((b) => b.text().includes('未判定を一括承認'));
    expect(bulk?.attributes('disabled')).toBeUndefined();
  });

  it('文字の変更タブでは、タブ内と決着箱の両方に一括承認が出る', async () => {
    setupState({ reloadFails: false, pendingRows: true });
    const w = mountDetail();
    await flushPromises();
    await buttonNamed(w, '文字の変更を一覧で見る')?.trigger('click');
    await flushPromises();
    expect(buttonsNamed(w, '未判定を一括承認')).toHaveLength(2);
  });

  it('未判定の変更パーツが無ければ、決着箱に一括承認は出ない', async () => {
    setupState({ reloadFails: false });
    const w = mountDetail();
    await flushPromises();
    expect(decisionBox(w).text()).not.toContain('未判定を一括承認');
  });

  it('決着箱の一括承認は、確認のうえ未判定パーツを承認済みにする', async () => {
    setupState({ reloadFails: false, pendingRows: true });
    const w = mountDetail();
    await flushPromises();
    await decisionBox(w)
      .findAll('button')
      .find((b) => b.text().includes('未判定を一括承認'))
      ?.trigger('click');
    await flushPromises();
    expect(vi.mocked(confirm)).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: '一括承認する' }),
    );
    expect(state.updatePartDecision).toHaveBeenCalledWith(
      expect.objectContaining({ partKey: 'p1', status: 'approved' }),
    );
  });
});

describe('ReviewDetail の最終確定を止める理由', () => {
  const blockedWith = async (opts: Parameters<typeof setupState>[0], message: string) => {
    setupState(opts);
    const w = mountDetail();
    await flushPromises();
    expect(buttonNamed(w, '最終確定する')?.attributes('disabled')).toBeDefined();
    expect(w.text()).toContain(message);
  };

  it('差分が打ち切られていれば最終確定できず、理由を出す', async () => {
    await blockedWith({ reloadFails: false, truncated: true }, '差分の上限を超えて');
  });

  it('同じパーツの判定が複数あれば最終確定できず、該当キーを出す', async () => {
    await blockedWith(
      { reloadFails: false, duplicates: ['p1'] },
      '同じパーツの判定が複数あるため最終確定できません: p1',
    );
  });

  it('比較元の無い古い edit 申請に判定があれば最終確定できず、申請し直しを求める', async () => {
    const decided = {
      partKey: 'p1',
      status: 'approved' as const,
      decidedBy: 'boss',
      decidedAt: '2026-10-02T00:00:00.000Z',
      comment: null,
      history: [],
    };
    await blockedWith(
      { reloadFails: false, review: { partDecisions: [decided] } },
      '申請し直してください',
    );
  });

  it('比較元のある edit 申請なら、判定があっても止めない', async () => {
    setupState({
      reloadFails: false,
      review: {
        baseHtml: '<p>a</p>',
        baseCss: '',
        partDecisions: [
          {
            partKey: 'p1',
            status: 'approved',
            decidedBy: 'boss',
            decidedAt: '2026-10-02T00:00:00.000Z',
            comment: null,
            history: [],
          },
        ],
      },
    });
    const w = mountDetail();
    await flushPromises();
    expect(buttonNamed(w, '最終確定する')?.attributes('disabled')).toBeUndefined();
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
