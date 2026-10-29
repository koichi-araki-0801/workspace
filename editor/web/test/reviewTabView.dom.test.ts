// =============================================================================
// reviewTabView.test.ts — 承認タブの対象解決・見出し・絞り込み・アコーディオン・宛先
// =============================================================================
// 組版 iframe を持つ `ReviewDetail` と `CommentPanel` は render 関数の stub にし、一覧の状態機械と
// 宛先の受け渡しだけを固定する(実描画は e2e `review_tab.spec.ts` が覆う)。`ReviewDetail` の stub は
// `#comments` の slot を本物と同じ形の props で描き、`select` を emit できる。`CommentPanel` の stub
// は受けた props を data 属性へ写し、ボタンで `focus` と `add` を emit する。
import {
  err,
  ok,
  type PartNoteEntry,
  type ReviewRequestMeta,
  type Template,
  unexpected,
} from '@editor/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, reactive, type SlotsType } from 'vue';
import ReviewTabView from '@/features/reviews/ReviewTabView.vue';

const TPL = 'XX01_950037_20240710_交付版';
const CREATE_TPL = 'XX01_910024_交付版';
const COVER = 'h1#1';

/** `PartNoteEntry` の全項目を埋める fixture(`as` は使わない)。 */
function noteEntry(patch: Partial<PartNoteEntry> = {}): PartNoteEntry {
  return {
    id: 'n1',
    templateId: TPL,
    pathKey: COVER,
    content: '',
    createdAt: '2026-09-03T00:00:00.000Z',
    createdBy: 'editor1',
    updatedAt: null,
    updatedBy: null,
    status: 'open',
    replyTo: null,
    ...patch,
  };
}

const listReviewsFn = vi.fn();
const getTemplateFn = vi.fn();
const getSampleDataFn = vi.fn();
const listNotesFn = vi.fn();
const addNoteFn = vi.fn(
  async (templateId: string, pathKey: string, content: string, opts: Partial<PartNoteEntry> = {}) =>
    ok(noteEntry({ templateId, pathKey, content, ...opts })),
);
const push = vi.fn();
const refresh = vi.fn();
const gotoPage = vi.fn();
const selectPart = vi.fn();
const openRequestReject = vi.fn();
/**
 * stub の `ReviewDetail` が公開する `canDecide`(本物は読み込んだ申請の状態と権限から決める)。
 * 申請 id ごとに上書きでき、無ければ承認者かどうかに従う。
 */
const canDecideOf = reactive<Record<string, boolean>>({});
/** stub の `ReviewDetail` が `#comments` へ渡す値(本物は変更の一覧から作る)。 */
const slotProps = reactive({
  selectedNo: null as number | null,
  selectedKey: null as string | null,
  partNumbers: new Map<string, number>(),
  partNames: new Map<string, string>(),
});
const route = reactive({ query: {} as Record<string, string> });
const auth = reactive({ isApprover: true });

vi.mock('@/api/repositories', async () => {
  const { ok } = await import('@editor/shared');
  return {
    useReviewRepo: () => ({ listReviews: listReviewsFn }),
    useTemplateRepo: () => ({
      getTemplate: getTemplateFn,
      getSampleData: getSampleDataFn,
      // 属性欄の委託会社・ファンド名(Rep1)。この画面の関心ではないので空で返す。
      listCompanies: async () => ok([]),
      listFunds: async () => ok([]),
    }),
    useNoteRepo: () => ({ listNotes: listNotesFn, addNote: addNoteFn }),
  };
});
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push }) }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/stores/pendingReviews', () => ({ usePendingReviewsStore: () => ({ refresh }) }));

const ATTRS = {
  companyCode: 'XX01',
  fundCode: '950037',
  baseDate: '20240710',
  editionType: '交付版',
};

function meta(patch: Partial<ReviewRequestMeta>): ReviewRequestMeta {
  return {
    id: 'rv1',
    templateId: TPL,
    attributes: ATTRS,
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
    html: '<h1></h1><p></p>',
    css: '',
    filled: '',
    ...patch,
  };
}

/**
 * `ReviewDetail` の代役。expose を数え、`#comments` の slot を本物と同じ props で描く。
 * `selectPart` は本物と同じく、変更のあるキーなら選択を slot props へ写して `select` を emit する。
 */
const ReviewDetailStub = defineComponent({
  name: 'ReviewDetail',
  props: { reqId: { type: String, required: true } },
  emits: ['decided', 'select'],
  slots: Object as SlotsType<{ comments: typeof slotProps }>,
  setup(props, { expose, slots, emit }) {
    expose({
      canDecide: computed(() => canDecideOf[props.reqId] ?? auth.isApprover),
      gotoPage,
      selectPart: (key: string) => {
        selectPart(key);
        const no = slotProps.partNumbers.get(key);
        if (no === undefined) return;
        slotProps.selectedNo = no;
        slotProps.selectedKey = key;
        emit('select', key, no);
      },
      openRequestReject,
    });
    return () => h('div', { 'data-stub-detail': '' }, slots.comments?.(slotProps));
  },
});

/** 紙面で選んだときの `ReviewDetail`: 選択を slot props へ写して `select` を emit する。 */
function pickOnPaper(detail: VueWrapper, key: string | null, no: number): void {
  slotProps.selectedNo = no;
  slotProps.selectedKey = key;
  detail.vm.$emit('select', key, no);
}

/** `CommentPanel` の代役。受けた props を data 属性へ写し、ボタンで `focus` と `add` を emit する。 */
const CommentPanelStub = defineComponent({
  name: 'CommentPanel',
  // 真偽の props は本物と同じく `Boolean` で受ける(値なしの属性 `compact` を true と読む)。
  props: {
    entries: Array,
    selectedKey: String,
    canAdd: Boolean,
    partLabels: Map,
    partNumbers: Map,
    partNames: Map,
    addBlockedText: String,
    collapseInputUntilTarget: Boolean,
    compact: Boolean,
  },
  emits: ['focus', 'add'],
  setup(props, { emit }) {
    return () =>
      h(
        'div',
        {
          'data-stub-panel': '',
          'data-selected-key': props.selectedKey ?? '',
          'data-can-add': String(props.canAdd),
          'data-blocked': props.addBlockedText ?? '',
          'data-collapse': String(props.collapseInputUntilTarget),
        },
        [
          h('button', { 'data-stub-focus': '', onClick: () => emit('focus', COVER) }),
          h('button', { 'data-stub-add': '', onClick: () => emit('add', '本文') }),
        ],
      );
  },
});

beforeEach(() => {
  listReviewsFn.mockReset().mockResolvedValue(ok([]));
  getTemplateFn.mockReset().mockResolvedValue(ok(template()));
  getSampleDataFn.mockReset().mockResolvedValue(ok({ sample: {}, warnings: [] }));
  listNotesFn.mockReset().mockResolvedValue(ok([]));
  addNoteFn.mockClear();
  push.mockClear();
  refresh.mockClear();
  gotoPage.mockClear();
  selectPart.mockClear();
  openRequestReject.mockClear();
  for (const k of Object.keys(canDecideOf)) delete canDecideOf[k];
  slotProps.selectedNo = null;
  slotProps.selectedKey = null;
  slotProps.partNumbers = new Map();
  slotProps.partNames = new Map();
  route.query = {};
  auth.isApprover = true;
});

async function mountTab(metas: ReviewRequestMeta[]) {
  listReviewsFn.mockResolvedValue(ok(metas));
  const w = mount(ReviewTabView, {
    global: {
      stubs: {
        ReviewDetail: ReviewDetailStub,
        CommentPanel: CommentPanelStub,
        FundCodeName: true,
      },
    },
  });
  await flushPromises();
  return w;
}

describe('対象テンプレートの解決', () => {
  it('query なしで開くと全申請を状態別に表示する', async () => {
    const w = await mountTab([
      meta({ id: 'pending-edit' }),
      meta({
        id: 'approved-create',
        templateId: CREATE_TPL,
        attributes: {
          companyCode: 'XX01',
          fundCode: '910024',
          editionType: '交付版',
        },
        origin: 'create',
        status: 'approved',
        reviewedBy: '管理者',
        reviewedAt: '2026-10-20T03:30:34.000Z',
      }),
      meta({
        id: 'rejected-other',
        templateId: 'XX01_999999_20250101_全体版',
        status: 'rejected',
      }),
    ]);

    expect(w.find('[data-review-chip="pending"]').text()).toContain('1');
    expect(w.find('[data-review-chip="approved"]').text()).toContain('1');
    expect(w.find('[data-review-chip="rejected"]').text()).toContain('1');

    await w.find('[data-review-chip="approved"]').trigger('click');

    expect(w.find('[data-review-item="approved-create"]').exists()).toBe(true);
    expect(w.find('[data-review-item="approved-create"]').text()).toContain('作成');
  });
  it('全件一覧で申請を選ぶと、その申請のテンプレート詳細を開く', async () => {
    const w = await mountTab([
      meta({
        id: 'approved-create',
        templateId: CREATE_TPL,
        attributes: {
          companyCode: 'XX01',
          fundCode: '910024',
          editionType: '交付版',
        },
        origin: 'create',
        status: 'approved',
      }),
    ]);

    await w.find('[data-review-chip="approved"]').trigger('click');
    await w.find('[data-review-item="approved-create"] [data-review-toggle]').trigger('click');

    expect(push).toHaveBeenCalledWith({
      name: 'reviews',
      query: { template: CREATE_TPL },
    });
  });

  it('template query の対象から「編集画面へ」を押すと、その id へ飛ぶ', async () => {
    route.query = { template: TPL };

    const w = await mountTab([meta({})]);

    expect(w.findAll('[data-review-item]')).toHaveLength(1);

    await w
      .findAll('button')
      .find((button) => button.text() === '編集画面へ')
      ?.trigger('click');

    expect(push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: TPL },
    });
  });

  it('対象が `status:"draft"`(pending だけ)なら「編集画面へ」は作成経路で開く', async () => {
    route.query = { template: TPL };

    getTemplateFn.mockResolvedValue(
      ok(template({ meta: { ...template().meta, status: 'draft' } })),
    );

    const w = await mountTab([meta({})]);
    // `loadParts` はメタ取得を待つので、押す前に解決させる(押した時点のメタで経路が決まる)。
    await flushPromises();
    await w
      .findAll('button')
      .find((b) => b.text() === '編集画面へ')
      ?.trigger('click');
    expect(push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: TPL },
      query: { created: '1' },
    });
  });

  it('メタが取れないとき、承認済みの作成申請しか無ければ編集経路で開く', async () => {
    route.query = { template: TPL };

    getTemplateFn.mockResolvedValue(err(unexpected('読み取り失敗')));
    const w = await mountTab([meta({ origin: 'create', status: 'approved' })]);
    await flushPromises();
    await w
      .findAll('button')
      .find((b) => b.text() === '編集画面へ')
      ?.trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'editor', params: { id: TPL } });
  });

  it('メタが取れないとき、承認待ちの作成申請があれば作成経路で開く', async () => {
    route.query = { template: TPL };

    getTemplateFn.mockResolvedValue(err(unexpected('読み取り失敗')));

    const w = await mountTab([meta({ origin: 'create', status: 'pending' })]);
    await flushPromises();
    await w
      .findAll('button')
      .find((b) => b.text() === '編集画面へ')
      ?.trigger('click');
    expect(push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: TPL },
      query: { created: '1' },
    });
  });

  it('query の template があれば対象テンプレートの詳細を表示する', async () => {
    route.query = { template: TPL };

    const w = await mountTab([meta({})]);

    expect(w.text()).toContain(TPL);
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
    expect(w.findComponent(ReviewDetailStub).exists()).toBe(true);
  });
  it('query なしではパンくずが「すべての申請」だけで、「編集画面へ」を出さない', async () => {
    const w = await mountTab([meta({ id: 'pending' })]);
    const crumb = w.find('[data-review-crumb]');
    expect(crumb.text()).toBe('すべての申請');
    expect(crumb.find('button').exists()).toBe(false);
    expect(w.findAll('button').some((b) => b.text() === '編集画面へ')).toBe(false);
    expect(w.find('[data-review-mode]').exists()).toBe(false);
  });

  it('対象テンプレート詳細のパンくずは ID を示し、「すべての申請」で全申請一覧へ戻る', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({})]);
    const crumb = w.find('[data-review-crumb]');
    expect(crumb.text().replace(/\s/g, '')).toBe(`すべての申請›${TPL}`);
    expect(crumb.find('[data-review-crumb-id]').attributes('data-break-anywhere')).toBeDefined();
    await crumb.find('button').trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'reviews' });
  });
});

describe('見出しと状態の絞り込み', () => {
  it('見出しは 1 行で、パンくず・状態のチップ・編集画面へを出し、件数の箱を出さない', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b', status: 'rejected' })]);
    const head = w.find('[data-review-head]');
    expect(head.find('[data-review-crumb]').exists()).toBe(true);
    expect(head.findAll('[data-review-chip]').map((c) => c.text())).toEqual([
      '承認待ち 1',
      '承認済み 0',
      '却下済み 1',
    ]);
    expect(head.findAll('button').some((b) => b.text() === '編集画面へ')).toBe(true);
    expect(w.find('[data-review-summary]').exists()).toBe(false);
    expect(w.text()).not.toContain('対象テンプレートの申請を、1件ずつ確認して');
    expect(w.find('.text-2xl').exists()).toBe(false);
  });

  it('チップの再押下で絞り込みを解除する', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b', status: 'approved' })]);
    const chip = () => w.find('[data-review-chip="pending"]');
    expect(chip().attributes('aria-pressed')).toBe('true');
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
    await chip().trigger('click');
    expect(chip().attributes('aria-pressed')).toBe('false');
    expect(w.findAll('[data-review-item]')).toHaveLength(2);
    await chip().trigger('click');
    expect(chip().attributes('aria-pressed')).toBe('true');
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
  });

  it('全申請の一覧はチップを見出しの行に置き、検索欄も残す', async () => {
    const w = await mountTab([meta({ id: 'a' })]);
    expect(w.find('[data-review-head] [data-review-chip="pending"]').exists()).toBe(true);
    expect(w.find('[data-review-search]').exists()).toBe(true);
  });

  it('3 つのチップの件数を対象テンプレートの申請から数え、既定は承認待ちだけを並べる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([
      meta({ id: 'a' }),
      meta({ id: 'b', status: 'approved' }),
      meta({ id: 'c', status: 'rejected' }),
      meta({ id: 'd', templateId: 'OTHER' }),
    ]);
    expect(w.find('[data-review-chip="pending"]').text()).toContain('1');
    expect(w.find('[data-review-chip="approved"]').text()).toContain('1');
    expect(w.find('[data-review-chip="rejected"]').text()).toContain('1');
    expect(w.findAll('[data-review-item]')).toHaveLength(1);
    expect(w.find('[data-review-chip="pending"]').attributes('aria-pressed')).toBe('true');
  });

  it('チップをもう一度押すと絞り込みが外れ、新しい順に全件並ぶ', async () => {
    route.query = { template: TPL };
    const w = await mountTab([
      meta({ id: 'old', submittedAt: '2026-09-01T00:00:00.000Z' }),
      meta({ id: 'new', status: 'approved', submittedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    await w.find('[data-review-chip="pending"]').trigger('click');
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
    // `button` の内容モデルは phrasing content に限られる(`div` は不可)。`AttributeBar` は
    // `inline` 指定で `span` ルートを描くので、行ヘッダの内側に `div` が残っていないことを検査する。
    expect(w.find('[data-review-toggle] div').exists()).toBe(false);
    // 中の読み上げ用の文字(`sr-only`、absolute)をボタンの中に留める(文書の高さを伸ばさない)。
    const toggle = w.find('[data-review-toggle]');
    expect(toggle.find('.sr-only').exists()).toBe(true);
    expect(toggle.classes()).toContain('relative');
    await w.findAll('[data-review-toggle]')[1].trigger('click');
    await w.findAll('[data-review-toggle]')[2].trigger('click');
    expect(expandedCount()).toBe(2);
    expect(w.find('[data-review-item="a"] [data-stub-detail]').exists()).toBe(false);
    // 1 件目(a)は最古として閉じ、3 件目(c)は開いたまま — `aria-expanded` が実際の展開状態と一致する。
    expect(w.findAll('[data-review-toggle]')[0].attributes('aria-expanded')).toBe('false');
    expect(w.findAll('[data-review-toggle]')[2].attributes('aria-expanded')).toBe('true');
  });

  it('絞り込みを切り替えると見えない id を捨て、可視の先頭を開き直す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b', status: 'approved' })]);
    await w.find('[data-review-chip="approved"]').trigger('click');
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
    expect(w.find('[data-review-reject-link]').exists()).toBe(false);
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

describe('申請の見出し', () => {
  it('展開中の承認待ちだけに「申請ごと却下する…」を出し、押すと openRequestReject を呼ぶ', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b' })]);
    const link = (id: string) => w.find(`[data-review-item="${id}"] [data-review-reject-link]`);
    expect(link('a').exists()).toBe(true);
    expect(link('a').text()).toBe('申請ごと却下する…');
    expect(link('b').exists()).toBe(false);
    // リンクは開閉のボタンの外の別ボタン(button の入れ子にしない)。
    expect(w.find('[data-review-toggle] [data-review-reject-link]').exists()).toBe(false);
    await link('a').trigger('click');
    expect(openRequestReject).toHaveBeenCalledTimes(1);
  });

  it('一覧では承認待ちでも、開いた申請が判定できない(先に決着していた)なら出さない', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    const link = () => w.find('[data-review-item="a"] [data-review-reject-link]');
    expect(link().exists()).toBe(true);
    // 開いた申請を読み直したら決着済みだった(一覧の行はまだ承認待ち)。
    canDecideOf.a = false;
    await flushPromises();
    expect(link().exists()).toBe(false);
  });

  it('開閉のボタンは開いた中身を aria-controls で指し、閉じている間は指さない', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b' })]);
    const toggle = (id: string) => w.find(`[data-review-item="${id}"] [data-review-toggle]`);
    const panelId = toggle('a').attributes('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = w.find(`#${panelId}`);
    expect(panel.exists()).toBe(true);
    expect(panel.find('[data-stub-detail]').exists()).toBe(true);
    expect(toggle('b').attributes('aria-controls')).toBeUndefined();
  });

  it('決着済みの申請には「申請ごと却下する…」を出さない', async () => {
    route.query = { template: TPL };
    canDecideOf.a = false;
    const w = await mountTab([meta({ id: 'a', status: 'approved', reviewedBy: 'x' })]);
    await w.find('[data-review-chip="approved"]').trigger('click');
    expect(w.find('[data-stub-detail]').exists()).toBe(true);
    expect(w.find('[data-review-reject-link]').exists()).toBe(false);
  });

  it('展開すると申告件数を出さない', async () => {
    route.query = { template: TPL };
    const changedSummary = { count: 2, names: ['表紙'] };
    const w = await mountTab([
      meta({ id: 'a', changedSummary }),
      meta({ id: 'b', changedSummary }),
    ]);
    expect(w.find('[data-review-item="a"]').text()).not.toContain('申請者の申告');
    expect(w.find('[data-review-item="b"]').text()).toContain('変更 2 か所');
    await w.findAll('[data-review-toggle]')[1].trigger('click');
    expect(w.find('[data-review-item="b"]').text()).not.toContain('申請者の申告');
  });

  it('作成経路の種別は「作成」、状態の語は「却下済み」', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a', origin: 'create', status: 'rejected' })]);
    await w.find('[data-review-chip="rejected"]').trigger('click');
    const toggle = w.find('[data-review-toggle]');
    expect(toggle.text()).toContain('却下済み');
    expect(toggle.text()).toContain('作成');
    expect(toggle.text()).not.toContain('新規作成');
  });
});

/** 確定版(`html` = `<h1></h1><p></p>`)のパーツ。`h1#1` がパーツ 1、`p#1` がパーツ 2。 */
const P = 'p#1';
const ADDED = 'section#9';
const ADDED_BLOCKED = '追加したパーツは確定版にまだ無いため、コメントを書けません。';

describe('コメントの宛先', () => {
  it('宛先が決まるまでは入力欄を畳む(collapseInputUntilTarget・宛先なし)', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    const panel = w.find('[data-stub-panel]');
    expect(panel.attributes('data-collapse')).toBe('true');
    expect(panel.attributes('data-selected-key')).toBe('');
    expect(panel.attributes('data-can-add')).toBe('false');
    expect(panel.attributes('data-blocked')).toBe('');
    expect(w.find('select[aria-label="コメントの宛先パーツ"]').exists()).toBe(false);
  });

  it('編集経路: 紙面で選んだパーツの beforePartKey がコメントの宛先になる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    // `ReviewDetail` は編集経路で `beforePartKey` を `select` の第 1 引数に渡す。
    pickOnPaper(w.findComponent(ReviewDetailStub), P, 2);
    await flushPromises();
    const panel = w.find('[data-stub-panel]');
    expect(panel.attributes('data-selected-key')).toBe(P);
    expect(panel.attributes('data-can-add')).toBe('true');
    await w.find('[data-stub-add]').trigger('click');
    await flushPromises();
    expect(addNoteFn).toHaveBeenCalledWith(TPL, P, '本文');
  });

  it('編集経路: 追加パーツ(beforePartKey が null)を選ぶと書けない理由を出す', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    pickOnPaper(w.findComponent(ReviewDetailStub), null, 3);
    await flushPromises();
    const panel = w.find('[data-stub-panel]');
    expect(panel.attributes('data-selected-key')).toBe('');
    expect(panel.attributes('data-can-add')).toBe('false');
    expect(panel.attributes('data-blocked')).toBe(ADDED_BLOCKED);
    await w.find('[data-stub-add]').trigger('click');
    await flushPromises();
    expect(addNoteFn).not.toHaveBeenCalled();
  });

  it('作成経路: 選んだパーツの partKey が partLabels にあればそれを宛先にし、無ければ書けない', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a', origin: 'create' })]);
    const detail = w.findComponent(ReviewDetailStub);
    // `ReviewDetail` は作成経路で申請版の `partKey` を渡す。確定版(partLabels)にあるキーだけ書ける。
    pickOnPaper(detail, COVER, 1);
    await flushPromises();
    expect(w.find('[data-stub-panel]').attributes('data-selected-key')).toBe(COVER);
    await w.find('[data-stub-add]').trigger('click');
    await flushPromises();
    expect(addNoteFn).toHaveBeenCalledWith(TPL, COVER, '本文');

    pickOnPaper(detail, ADDED, 2);
    await flushPromises();
    const panel = w.find('[data-stub-panel]');
    expect(panel.attributes('data-selected-key')).toBe('');
    expect(panel.attributes('data-can-add')).toBe('false');
    expect(panel.attributes('data-blocked')).toBe(ADDED_BLOCKED);
  });

  it('slot の番号と名前を CommentPanel へ渡す', async () => {
    route.query = { template: TPL };
    slotProps.partNumbers = new Map([[COVER, 1]]);
    slotProps.partNames = new Map([[COVER, '表紙']]);
    const w = await mountTab([meta({ id: 'a' })]);
    const panel = w.findComponent(CommentPanelStub);
    expect(panel.props('partNumbers')).toEqual(new Map([[COVER, 1]]));
    expect(panel.props('partNames')).toEqual(new Map([[COVER, '表紙']]));
    expect(panel.props('compact')).toBe(true);
  });

  it('一覧の見出し(focus)で変更のあるパーツを選ぶと ReviewDetail の selectPart で選ぶ', async () => {
    route.query = { template: TPL };
    slotProps.partNumbers = new Map([[COVER, 1]]);
    const w = await mountTab([meta({ id: 'a' })]);
    await w.find('[data-stub-focus]').trigger('click');
    expect(selectPart).toHaveBeenCalledWith(COVER);
    expect(gotoPage).not.toHaveBeenCalled();
    expect(w.find('[data-stub-panel]').attributes('data-selected-key')).toBe(COVER);
  });

  it('一覧の見出し(focus)で変更の無いパーツを選ぶと宛先にし、該当ページへ送る', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    await w.find('[data-stub-focus]').trigger('click');
    expect(w.find('[data-stub-panel]').attributes('data-selected-key')).toBe(COVER);
    expect(selectPart).not.toHaveBeenCalled();
    expect(gotoPage).toHaveBeenCalledWith(0);
  });

  it('宛先は filled があれば filled の構造から、無ければ html の構造から作る', async () => {
    route.query = { template: TPL };
    getTemplateFn.mockResolvedValue(
      ok(template({ html: '<h1></h1>', filled: '<h1></h1><p></p><table></table>' })),
    );
    const w = await mountTab([meta({ id: 'a' })]);
    const labels = w.findComponent(CommentPanelStub).props('partLabels') as Map<string, string>;
    expect(labels.size).toBe(3);
    expect(labels.has(P)).toBe(true);
  });
});

describe('宛先は紙面の選択に従う', () => {
  it('ReviewDetail の選択が外れる(slot の selectedNo が null)と宛先も外れる', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    pickOnPaper(w.findComponent(ReviewDetailStub), P, 2);
    await flushPromises();
    expect(w.find('[data-stub-panel]').attributes('data-selected-key')).toBe(P);
    slotProps.selectedNo = null;
    slotProps.selectedKey = null;
    await flushPromises();
    const panel = w.find('[data-stub-panel]');
    expect(panel.attributes('data-selected-key')).toBe('');
    expect(panel.attributes('data-blocked')).toBe('');
  });

  it('一覧で変更の無いパーツを選んだあと紙面で選ぶと、紙面の選択が宛先になる(後の操作が勝つ)', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    await w.find('[data-stub-focus]').trigger('click');
    expect(w.find('[data-stub-panel]').attributes('data-selected-key')).toBe(COVER);
    pickOnPaper(w.findComponent(ReviewDetailStub), P, 2);
    await flushPromises();
    expect(w.find('[data-stub-panel]').attributes('data-selected-key')).toBe(P);
    // 逆に、紙面で選んだあとに一覧で変更の無いパーツを選ぶと一覧の選択が勝つ。
    await w.find('[data-stub-focus]').trigger('click');
    expect(w.find('[data-stub-panel]').attributes('data-selected-key')).toBe(COVER);
  });
});

describe('確定版の構造が引けないときの案内', () => {
  it('getTemplate が失敗すると、入力欄の代わりに案内文言を出す', async () => {
    route.query = { template: TPL };
    getTemplateFn.mockResolvedValue(err(unexpected('読み取り失敗')));
    const w = await mountTab([meta({ id: 'a' })]);
    const panel = w.find('[data-stub-panel]');
    expect(panel.attributes('data-blocked')).toBe(
      'このテンプレートの確定版がまだ無いため、パーツ宛のコメントは付けられません',
    );
    expect(panel.attributes('data-can-add')).toBe('false');
  });

  it('getTemplate が未解決の間は確定版の案内を出さず、選ぶと読み込み中と出して書かせない', async () => {
    route.query = { template: TPL };
    getTemplateFn.mockReturnValue(new Promise(() => {}));
    const w = await mountTab([meta({ id: 'a' })]);
    expect(w.find('[data-stub-panel]').attributes('data-blocked')).toBe('');
    pickOnPaper(w.findComponent(ReviewDetailStub), COVER, 1);
    await flushPromises();
    const panel = w.find('[data-stub-panel]');
    // 「左の紙面でパーツを押すと…」(宛先なしの案内)にせず、読み込み中であることを出す。
    expect(panel.attributes('data-blocked')).toBe('確定版のパーツを読み込んでいます…');
    expect(panel.attributes('data-can-add')).toBe('false');
    expect(panel.attributes('data-selected-key')).toBe('');
  });
});

describe('宛先の区画別化(表示中の宛先へ投稿する)', () => {
  it('2 区画を同時展開して片方で選んでも、もう片方の宛先は決まらない', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' }), meta({ id: 'b' })]);
    await w.findAll('[data-review-toggle]')[1].trigger('click');
    pickOnPaper(w.findAllComponents(ReviewDetailStub)[0], COVER, 1);
    await flushPromises();
    const panels = w.findAll('[data-stub-panel]');
    expect(panels).toHaveLength(2);
    expect(panels[0].attributes('data-selected-key')).toBe(COVER);
    expect(panels[1].attributes('data-selected-key')).toBe('');
    await w.findAll('[data-stub-add]')[0].trigger('click');
    await flushPromises();
    expect(addNoteFn).toHaveBeenCalledWith(TPL, COVER, '本文');
  });

  it('宛先が未選択なら追加を押しても投稿しない(composable が null キーで早期 return する)', async () => {
    route.query = { template: TPL };
    const w = await mountTab([meta({ id: 'a' })]);
    await w.find('[data-stub-add]').trigger('click');
    await flushPromises();
    expect(addNoteFn).not.toHaveBeenCalled();
  });
});

describe('全申請一覧の検索', () => {
  it('ファンドコードの部分一致で申請と状態別件数を絞り込む', async () => {
    const w = await mountTab([
      meta({
        id: 'target-approved',
        templateId: CREATE_TPL,
        attributes: {
          companyCode: 'XX01',
          fundCode: '910024',
          editionType: '交付版',
        },
        origin: 'create',
        status: 'approved',
      }),
      meta({
        id: 'other-pending',
        templateId: 'XX01_950037_20251117_交付版',
        status: 'pending',
      }),
    ]);

    await w.find('input[aria-label="申請を検索"]').setValue('910024');

    expect(w.find('[data-review-chip="pending"]').text()).toContain('0');
    expect(w.find('[data-review-chip="approved"]').text()).toContain('1');

    await w.find('[data-review-chip="approved"]').trigger('click');

    expect(w.find('[data-review-item="target-approved"]').exists()).toBe(true);
    expect(w.find('[data-review-item="other-pending"]').exists()).toBe(false);
  });

  it('検索をクリアすると全申請へ戻る', async () => {
    const w = await mountTab([
      meta({ id: 'first' }),
      meta({
        id: 'second',
        templateId: CREATE_TPL,
        attributes: {
          companyCode: 'XX01',
          fundCode: '910024',
          editionType: '交付版',
        },
      }),
    ]);

    await w.find('input[aria-label="申請を検索"]').setValue('910024');
    expect(w.find('[data-review-chip="pending"]').text()).toContain('1');

    await w
      .findAll('button')
      .find((button) => button.text() === 'クリア')
      ?.trigger('click');

    expect(w.find('[data-review-chip="pending"]').text()).toContain('2');
  });

  it('検索結果が無い場合は専用の案内を表示する', async () => {
    const w = await mountTab([meta({ id: 'pending' })]);

    await w.find('input[aria-label="申請を検索"]').setValue('存在しないファンド');

    expect(w.text()).toContain('検索条件に一致する申請はありません');
  });
});
