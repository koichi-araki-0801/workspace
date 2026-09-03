// =============================================================================
// reviewTabView.test.ts — 承認タブの対象解決・要約箱・アコーディオン・ロール別見出し・宛先
// =============================================================================
// 組版 iframe を持つ `ReviewDetail` と `CommentPanel` は render 関数の stub にし、一覧の状態機械と
// 宛先の受け渡しだけを固定する(実描画は e2e `review_tab.spec.ts` が覆う)。stub からも `focus` を
// emit し、stub 化で通らなくなる `focusPart` / `goEdit` の経路を通す。
import { ok, type ReviewRequestMeta, type Template } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import ReviewTabView from '@/features/reviews/ReviewTabView.vue';

const listReviewsFn = vi.fn();
const getTemplateFn = vi.fn();
const getSampleDataFn = vi.fn();
const listNotesFn = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
const gotoPage = vi.fn();
const route = reactive({ query: {} as Record<string, string> });
const auth = reactive({ isApprover: true });
const editPath = { value: undefined as string | undefined };

vi.mock('@/api/repositories', () => ({
  useReviewRepo: () => ({ listReviews: listReviewsFn }),
  useTemplateRepo: () => ({ getTemplate: getTemplateFn, getSampleData: getSampleDataFn }),
  useNoteRepo: () => ({ listNotes: listNotesFn }),
}));
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push }) }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/stores/tabMemory', () => ({
  useTabMemoryStore: () => ({ pathFor: () => editPath.value }),
}));
vi.mock('@/stores/pendingReviews', () => ({ usePendingReviewsStore: () => ({ refresh }) }));

const TPL = 'AM01_510037_20240710_交付版';
const ATTRS = {
  companyCode: 'AM01',
  fundCode: '510037',
  baseDate: '20240710',
  editionType: '交付版',
};
const COVER = '.page#1/h1#1';

function meta(patch: Partial<ReviewRequestMeta>): ReviewRequestMeta {
  return {
    id: 'rv1',
    templateId: TPL,
    attributes: ATTRS,
    fundCode: '510037',
    origin: 'edit',
    status: 'pending',
    submittedBy: 'editor1',
    submittedAt: '2026-09-03T00:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: null,
    ...patch,
  };
}

/** 契約どおりの `Template`。`filled` は REST と同じく空にし、`html` の構造からパーツを引く。 */
function template(patch: Partial<Template> = {}): Template {
  return {
    meta: {
      id: TPL,
      attributes: ATTRS,
      fileName: `${TPL}.html`,
      status: 'published',
      updatedAt: '2026-09-03T00:00:00.000Z',
      updatedBy: 'editor1',
    },
    html: '<div class="page"><h1></h1><p></p></div>',
    css: '',
    filled: '',
    ...patch,
  };
}

/** `ReviewDetail` の代役。`gotoPage` を expose して `focusPart` の到達を数えられるようにする。 */
const ReviewDetailStub = defineComponent({
  name: 'ReviewDetail',
  props: { reqId: { type: String, required: true } },
  emits: ['decided'],
  setup(_, { expose }) {
    expose({ gotoPage });
    return () => h('div', { 'data-stub-detail': '' });
  },
});

/** `CommentPanel` の代役。ボタン 1 つで `focus` を emit する。 */
const CommentPanelStub = defineComponent({
  name: 'CommentPanel',
  props: ['entries', 'selectedKey', 'canAdd', 'partLabels', 'compact'],
  emits: ['focus'],
  setup(_, { emit }) {
    return () => h('button', { 'data-stub-focus': '', onClick: () => emit('focus', COVER) });
  },
});

beforeEach(() => {
  listReviewsFn.mockReset().mockResolvedValue(ok([]));
  getTemplateFn.mockReset().mockResolvedValue(ok(template()));
  getSampleDataFn.mockReset().mockResolvedValue(ok({}));
  listNotesFn.mockReset().mockResolvedValue(ok([]));
  push.mockClear();
  refresh.mockClear();
  gotoPage.mockClear();
  route.query = {};
  auth.isApprover = true;
  editPath.value = undefined;
});

async function mountTab(metas: ReviewRequestMeta[]) {
  listReviewsFn.mockResolvedValue(ok(metas));
  const w = mount(ReviewTabView, {
    global: {
      stubs: {
        ReviewDetail: ReviewDetailStub,
        CommentPanel: CommentPanelStub,
        AttributeBar: true,
        FundCodeName: true,
      },
    },
  });
  await flushPromises();
  return w;
}

describe('対象テンプレートの解決', () => {
  it('query も編集タブの記憶も無ければ誘導の空状態を出し、「編集タブへ」で一覧へ戻る', async () => {
    const w = await mountTab([]);
    expect(w.text()).toContain('編集タブでテンプレートを開いてから');
    expect(w.find('[data-review-summary]').exists()).toBe(false);
    await w.find('button').trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'edit' });
  });

  it('編集タブの直前画面 /edit/:id から対象を取り、「編集画面へ」はその id へ飛ぶ', async () => {
    editPath.value = `/edit/${encodeURIComponent(TPL)}`;
    const w = await mountTab([meta({})]);
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
    await w
      .findAll('button')
      .find((b) => b.text() === '編集画面へ')
      ?.trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'editor', params: { id: TPL } });
  });

  it('query の template が編集タブの記憶より優先される', async () => {
    editPath.value = '/edit/OTHER';
    route.query = { template: TPL };
    const w = await mountTab([meta({})]);
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
  });
});

describe('要約箱と絞り込み', () => {
  it('3 箱の件数を対象テンプレートの申請から数え、既定は承認待ちだけを並べる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([
      meta({ id: 'a' }),
      meta({ id: 'b', status: 'approved' }),
      meta({ id: 'c', status: 'rejected' }),
      meta({ id: 'd', templateId: 'OTHER' }),
    ]);
    expect(w.find('[data-summary="pending"]').text()).toContain('1');
    expect(w.find('[data-summary="approved"]').text()).toContain('1');
    expect(w.find('[data-summary="rejected"]').text()).toContain('1');
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
    expect(w.find('[data-summary="pending"]').attributes('aria-pressed')).toBe('true');
  });

  it('箱をもう一度押すと絞り込みが外れ、新しい順に全件並ぶ', async () => {
    route.query = { template: TPL };
    const w = await mountTab([
      meta({ id: 'old', submittedAt: '2026-09-01T00:00:00.000Z' }),
      meta({ id: 'new', status: 'approved', submittedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    await w.find('[data-summary="pending"]').trigger('click');
    expect(w.findAll('[data-review-item]').map((i) => i.attributes('data-review-item'))).toEqual([
      'new',
      'old',
    ]);
  });
});

describe('アコーディオン', () => {
  it('先頭だけ展開され、3 件目を開くと最古が閉じる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b' }), meta({ id: 'c' })]);
    const expandedCount = () => w.findAll('[data-stub-detail]').length;
    expect(expandedCount()).toBe(1);
    await w.findAll('[data-review-toggle]')[1].trigger('click');
    await w.findAll('[data-review-toggle]')[2].trigger('click');
    expect(expandedCount()).toBe(2);
    expect(w.find('[data-review-item="a"] [data-stub-detail]').exists()).toBe(false);
  });

  it('絞り込みを切り替えると見えない id を捨て、可視の先頭を開き直す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b', status: 'approved' })]);
    await w.find('[data-summary="approved"]').trigger('click');
    expect(w.findAll('[data-stub-detail]')).toHaveLength(1);
    expect(w.find('[data-review-item="b"]').exists()).toBe(true);
  });
});

describe('ロール別の見出しと決着後', () => {
  it('編集者には「申請状況」を出す', async () => {
    auth.isApprover = false;
    route.query = { template: TPL };
    const w = await mountTab([meta({})]);
    expect(w.find('h2').text()).toBe('申請状況');
  });

  it('承認待ちが 0 件になると「編集タブへ戻る」を出し、pendingReviews を取り直す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    w.findComponent(ReviewDetailStub).vm.$emit(
      'decided',
      meta({ id: 'a', status: 'approved', reviewedBy: 'approver', reviewedAt: 'x' }),
    );
    await flushPromises();
    expect(refresh).toHaveBeenCalled();
    expect(w.text()).toContain('編集タブへ戻る');
  });
});

describe('コメントの宛先', () => {
  it('一覧の行(stub の focus)で宛先が選ばれ、該当ページへ送られる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    await w.find('[data-stub-focus]').trigger('click');
    expect(
      (w.find('select[aria-label="コメントの宛先パーツ"]').element as HTMLSelectElement).value,
    ).toBe(COVER);
    expect(gotoPage).toHaveBeenCalledWith(0);
  });

  it('宛先の選択肢は filled があれば filled の構造から、無ければ html の構造から作る', async () => {
    route.query = { template: TPL };
    getTemplateFn.mockResolvedValue(
      ok(
        template({
          html: '<div class="page"><h1></h1></div>',
          filled: '<div class="page"><h1></h1><p></p><table></table></div>',
        }),
      ),
    );
    const w = await mountTab([meta({ id: 'a' })]);
    expect(w.findAll('select[aria-label="コメントの宛先パーツ"] option')).toHaveLength(1 + 3);
  });
});
