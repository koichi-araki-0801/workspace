// =============================================================================
// CreateTabView.dom.test.ts — 作成済み・作成中のテンプレートの開き方と、作り直しの確認
// =============================================================================
// テンプレートは会社・ファンド・版種に 1 つ。作成済みなら「既存のテンプレートを開く」だけを出し、
// 新規作成とシリーズから作成は押せない(押しても 409)。作成中(下書きか pending がある)なら
// 「作成中のテンプレートを開く」を出し、作り直すときは確認して同意を得てから replaceExisting で送る。
import { type CompanyOption, type CreatableInfo, type FundOption, ok } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import CreateTabView from '@/features/templates/CreateTabView.vue';
import CreateFundSelect from '@/features/templates/components/CreateFundSelect.vue';

const { routeQuery, router, confirmMock, toastMock } = vi.hoisted(() => {
  const routeQuery: Record<string, unknown> = {};
  const router = {
    currentRoute: { value: { query: {} as Record<string, unknown> } },
    replace: vi.fn(() => Promise.resolve()),
    push: vi.fn(() => Promise.resolve()),
  };
  return { routeQuery, router, confirmMock: vi.fn(async () => true), toastMock: vi.fn() };
});
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => router,
}));
vi.mock('@/components/ui/toast', () => ({
  toast: toastMock,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@/components/ui/confirm', () => ({ confirm: confirmMock }));

const COMPANIES: CompanyOption[] = [
  { companyCode: 'XX01', companyName: '会社 1', rep1CompanyCode: 'R-XX01' },
];
const FUNDS: FundOption[] = [{ fundCode: '950037', fundName: 'ファンド' }];
const SERIES = [{ fundCode: '950003', fundName: '安定型', hasTemplate: true }];
const ID = 'XX01_950037_交付版';

function mountWith(info: CreatableInfo, edition: string | null = '交付版') {
  Object.assign(routeQuery, {
    companyCode: 'XX01',
    fundCode: '950037',
    ...(edition === null ? {} : { editionType: edition }),
  });
  const templates = {
    listCompanies: vi.fn(async () => ok(COMPANIES)),
    listFunds: vi.fn(async () => ok(FUNDS)),
    getCreatableInfo: vi.fn(async () => ok(info)),
    generate: vi.fn(async () =>
      ok({
        template: {
          meta: {
            id: ID,
            attributes: { companyCode: 'XX01', fundCode: '950037', editionType: '交付版' },
            fileName: `${ID}.html`,
            status: 'draft',
            updatedAt: null,
            updatedBy: null,
          },
          html: '',
          css: '',
          filled: '',
        },
        imported: [{ templateId: ID, editionType: '交付版' }],
        skipped: [],
      }),
    ),
  };
  const w = mount(CreateTabView, {
    global: { provide: { [REPOS_KEY as symbol]: { templates } } },
  });
  return { w, templates };
}

/** 会社の候補取得 → ファンドの取得 → 作成可否の取得(watch)の 3 段を流し切る。 */
async function settle() {
  await flushPromises();
  await flushPromises();
}

const buttonNamed = (w: ReturnType<typeof mount>, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text));

beforeEach(() => {
  for (const k of Object.keys(routeQuery)) delete routeQuery[k];
  router.push.mockClear();
  confirmMock.mockReset();
  toastMock.mockClear();
  confirmMock.mockResolvedValue(true);
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('CreateTabView', () => {
  it('作成済みなら「既存のテンプレートを開く」で作成経路の編集画面を開き、作成の 2 つは押せない', async () => {
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'created', templateId: ID }],
      seriesFunds: SERIES,
    });
    await settle();
    const open = buttonNamed(w, '既存のテンプレートを開く');
    expect(open).toBeDefined();
    await open?.trigger('click');
    expect(router.push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: ID },
      query: { created: '1' },
    });
    expect(buttonNamed(w, '属性から新規作成')?.attributes('disabled')).toBeDefined();
    expect(buttonNamed(w, '既存のシリーズを元に作成')?.attributes('disabled')).toBeDefined();
    expect(buttonNamed(w, '作成中のテンプレートを開く')).toBeUndefined();
    expect(templates.generate).not.toHaveBeenCalled();
  });

  it('選んだ版が申請中なら「申請中です」を出し、作成の 2 つは押せない', async () => {
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'pendingReview' }],
      seriesFunds: SERIES,
    });
    await settle();
    expect(w.text()).toContain(
      'この会社・ファンド・版種のテンプレートは申請中です。承認か却下を待ってください。',
    );
    expect(buttonNamed(w, '属性から新規作成')?.attributes('disabled')).toBeDefined();
    expect(buttonNamed(w, '既存のシリーズを元に作成')?.attributes('disabled')).toBeDefined();
    expect(buttonNamed(w, '作成中のテンプレートを開く')).toBeUndefined();
    expect(buttonNamed(w, '既存のテンプレートを開く')).toBeUndefined();
    expect(templates.generate).not.toHaveBeenCalled();
  });

  it('作成中なら「作成中のテンプレートを開く」で作成経路の編集画面を開く', async () => {
    const { w } = mountWith({
      editions: [{ editionType: '交付版', state: 'inProgress', templateId: ID }],
      seriesFunds: SERIES,
    });
    await settle();
    await buttonNamed(w, '作成中のテンプレートを開く')?.trigger('click');
    expect(router.push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: ID },
      query: { created: '1' },
    });
    expect(buttonNamed(w, '属性から新規作成')?.attributes('disabled')).toBeUndefined();
  });

  it('作成中の作り直しは確認し、断れば生成しない', async () => {
    confirmMock.mockResolvedValue(false);
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'inProgress', templateId: ID }],
      seriesFunds: [],
    });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '作業中の内容を捨てて作り直しますか' }),
    );
    expect(templates.generate).not.toHaveBeenCalled();
  });

  it('作成中の作り直しに同意すると replaceExisting で生成し、作成経路の編集画面へ進む', async () => {
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'inProgress', templateId: ID }],
      seriesFunds: [],
    });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.objectContaining({ fundCode: '950037', replaceExisting: true }),
    );
    expect(router.push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: ID },
      query: { created: '1' },
    });
  });

  it('作り直しの確認文は、作る版(版種を選べばその版)について捨てることを伝える', async () => {
    const { w } = mountWith({
      editions: [{ editionType: '交付版', state: 'inProgress', templateId: ID }],
      seriesFunds: [],
    });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          '交付版について、作成中のテンプレートの下書きと生成した内容を捨てて、新しく作り直します。コメントと修正履歴は残ります。',
      }),
    );
  });

  it('生成の要求に Rep1 の会社コードを載せる', async () => {
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'none' }],
      seriesFunds: [],
    });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.objectContaining({ rep1CompanyCode: 'R-XX01' }),
    );
  });

  it('基準日の入力欄を出さず、要求に baseDate を載せない', async () => {
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'none' }],
      seriesFunds: [],
    });
    await settle();
    expect(w.find('input[type="date"]').exists()).toBe(false);
    expect(w.text()).not.toContain('基準日');
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate.mock.calls[0][0]).not.toHaveProperty('baseDate');
  });

  it.each([
    ['created' as const, '全体版は作成済みのため飛ばしました'],
    ['pendingReview' as const, '全体版は申請中のため飛ばしました'],
  ])('飛ばした版があれば知らせる(%s)', async (reason, message) => {
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'none' }],
      seriesFunds: [],
    });
    const first = await templates.generate();
    templates.generate.mockResolvedValueOnce(
      ok({
        ...(first as { value: object }).value,
        skipped: [{ templateId: 'XX01_950037_全体版', editionType: '全体版', reason }],
      }) as never,
    );
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(toastMock).toHaveBeenCalledWith(message);
  });

  it('飛ばした版が無ければ、その通知は出さない', async () => {
    const { w } = mountWith({
      editions: [{ editionType: '交付版', state: 'none' }],
      seriesFunds: [],
    });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('作成済みでも作成中でもなければ、確認せずに生成し「開く」ボタンは出ない', async () => {
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'none' }],
      seriesFunds: [],
    });
    await settle();
    expect(buttonNamed(w, '既存のテンプレートを開く')).toBeUndefined();
    expect(buttonNamed(w, '作成中のテンプレートを開く')).toBeUndefined();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.not.objectContaining({ replaceExisting: true }),
    );
  });

  it('問い合わせ中に属性が欠けたら、前の属性の作成可否が後から届いても反映しない', async () => {
    let release: (v: unknown) => void = () => {};
    const { w, templates } = mountWith({
      editions: [{ editionType: '交付版', state: 'none' }],
      seriesFunds: [],
    });
    templates.getCreatableInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as never,
    );
    await settle();
    const select = w.findComponent(CreateFundSelect);
    select.vm.$emit('update', {
      companyCode: 'XX01',
      rep1CompanyCode: 'R-XX01',
      fundCode: '510099',
      editionType: '交付版',
    });
    await settle();
    select.vm.$emit('update', {
      companyCode: 'XX01',
      rep1CompanyCode: 'R-XX01',
      fundCode: undefined,
      editionType: undefined,
    });
    await settle();
    release(ok({ editions: [{ editionType: '交付版', state: 'none' }], seriesFunds: SERIES }));
    await settle();
    // 前の属性(510099)のシリーズ候補で「シリーズから作成」カードが現れない。
    expect(buttonNamed(w, '既存のシリーズを元に作成')).toBeUndefined();
  });
});

describe('CreateTabView: 版種を任意にした作成', () => {
  const ZENTAI = 'XX01_950037_全体版';
  const both = (
    k: CreatableInfo['editions'][number]['state'],
    z: CreatableInfo['editions'][number]['state'],
  ): CreatableInfo => ({
    editions: [
      {
        editionType: '交付版',
        state: k,
        ...(k === 'created' || k === 'inProgress' ? { templateId: ID } : {}),
      },
      {
        editionType: '全体版',
        state: z,
        ...(z === 'created' || z === 'inProgress' ? { templateId: ZENTAI } : {}),
      },
    ],
    seriesFunds: [],
  });
  const bothImported = () =>
    ok({
      meta: null,
      template: undefined,
      imported: [
        { templateId: ID, editionType: '交付版' },
        { templateId: ZENTAI, editionType: '全体版' },
      ],
      skipped: [],
    });
  const cards = (w: ReturnType<typeof mount>) => w.findAll('[data-testid="open-edition-card"]');

  it('版種を選ばなくても作成方法を押せ、要求に editionType を載せない', async () => {
    const { w, templates } = mountWith(both('none', 'none'), null);
    await settle();
    expect(buttonNamed(w, '属性から新規作成')?.attributes('disabled')).toBeUndefined();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledTimes(1);
    expect(templates.generate.mock.calls[0][0]).not.toHaveProperty('editionType');
  });

  it('両版ができたら編集画面へ移らず、成功の帯と「交付版を開く」「全体版を開く」を出し、押した版を作成経路で開く', async () => {
    const { w, templates } = mountWith(both('none', 'none'), null);
    templates.generate.mockResolvedValueOnce(bothImported() as never);
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    expect(w.text()).toContain(
      '交付版と全体版を作成しました。どちらを開くか選んでください。開かなかった版は、作成中のテンプレートから開けます。',
    );
    const found = cards(w);
    expect(found).toHaveLength(2);
    expect(found[0].text()).toContain('交付版を開く');
    expect(found[0].text()).toContain(ID);
    expect(found[1].text()).toContain('全体版を開く');
    expect(found[1].text()).toContain(ZENTAI);
    await found[1].trigger('click');
    expect(router.push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: ZENTAI },
      query: { created: '1' },
    });
  });

  it('両版を作った後は、問い合わせ直した作成可否が作業中でも「作成中の…を開く」の帯を出さない', async () => {
    const { w, templates } = mountWith(both('none', 'none'), null);
    templates.generate.mockResolvedValueOnce(bothImported() as never);
    await settle();
    templates.getCreatableInfo.mockResolvedValue(ok(both('inProgress', 'inProgress')) as never);
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.getCreatableInfo.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(buttonNamed(w, '作成中の交付版を開く')).toBeUndefined();
    expect(buttonNamed(w, '作成中の全体版を開く')).toBeUndefined();
    expect(cards(w)).toHaveLength(2);
  });

  it('作成に成功したら作成可否を問い合わせ直し、続けて作るときは同意を聞く', async () => {
    const { w, templates } = mountWith(both('none', 'none'), null);
    templates.generate.mockResolvedValueOnce(bothImported() as never);
    await settle();
    templates.getCreatableInfo.mockResolvedValue(ok(both('inProgress', 'inProgress')) as never);
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).not.toHaveBeenCalled();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it('属性を変えたら「…を開く」カードと成功の帯を消す', async () => {
    const { w, templates } = mountWith(both('none', 'none'), null);
    templates.generate.mockResolvedValueOnce(bothImported() as never);
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(cards(w)).toHaveLength(2);
    const select = w.findComponent(CreateFundSelect);
    select.vm.$emit('update', {
      companyCode: 'XX01',
      rep1CompanyCode: 'R-XX01',
      fundCode: '950155',
      editionType: undefined,
    });
    await settle();
    expect(cards(w)).toHaveLength(0);
    expect(w.text()).not.toContain('交付版と全体版を作成しました。');
  });

  it('版種を選ばず片方が作成済み・申請中なら、作成方法の上に 2 行の注記を出す', async () => {
    const created = mountWith(both('none', 'created'), null);
    await settle();
    expect(created.w.text()).toContain('全体版は作成済みです。交付版だけを作ります。');
    expect(created.w.text()).toContain(
      'あとで両版のパーツ同期を行うと、作成済みの全体版との差分が競合として出ることがあります。',
    );
    created.w.unmount();
    for (const k of Object.keys(routeQuery)) delete routeQuery[k];
    const reviewing = mountWith(both('none', 'pendingReview'), null);
    await settle();
    expect(reviewing.w.text()).toContain('全体版は申請中です。交付版だけを作ります。');
    expect(reviewing.w.text()).toContain(
      'あとで両版のパーツ同期を行うと、申請中の全体版との差分が競合として出ることがあります。',
    );
  });

  it.each([
    [
      '両版作成済み',
      'created' as const,
      'created' as const,
      '交付版・全体版とも作成済みです。直すときは既存のテンプレートを開いてください。',
      ['既存の交付版を開く', '既存の全体版を開く'],
    ],
    [
      '両版申請中',
      'pendingReview' as const,
      'pendingReview' as const,
      '交付版・全体版とも承認待ちです。',
      [],
    ],
    [
      '交付版作成済み・全体版申請中',
      'created' as const,
      'pendingReview' as const,
      '交付版は作成済みです。全体版は承認待ちです。',
      ['既存の交付版を開く'],
    ],
  ])(
    '版種を選ばず両版とも作れないときの帯と、作成方法を押せないこと(%s)',
    async (_l, k, z, text, buttons) => {
      const { w } = mountWith(both(k, z), null);
      await settle();
      expect(w.text()).toContain(text);
      expect(buttonNamed(w, '属性から新規作成')?.attributes('disabled')).toBeDefined();
      const opens = w
        .findAll('button')
        .map((b) => b.text().trim())
        .filter((t) => t.startsWith('既存の'));
      expect(opens).toEqual(buttons);
      if (buttons.includes('既存の全体版を開く')) {
        await buttonNamed(w, '既存の全体版を開く')?.trigger('click');
        expect(router.push).toHaveBeenCalledWith({
          name: 'editor',
          params: { id: ZENTAI },
          query: { created: '1' },
        });
      }
    },
  );

  it('版種を選ぶと Step 2 の説明に作る版と組入先を取り込まないことを出し、選ばなければ作成方法の説明から版種を外す', async () => {
    const chosen = mountWith(both('none', 'none'), '交付版');
    await settle();
    expect(chosen.w.text()).toContain(
      '交付版だけを作り、作成後はその編集画面が開きます。組入先は取り込みません。',
    );
    expect(chosen.w.text()).toContain(
      '委託会社・ファンドを選択してください。版種は、片方の版だけを作るときに選びます。',
    );
    chosen.w.unmount();
    for (const k of Object.keys(routeQuery)) delete routeQuery[k];
    const unchosen = mountWith(both('none', 'none'), null);
    await settle();
    expect(unchosen.w.text()).toContain(
      '指定した属性（委託会社・ファンド）をもとに標準レイアウトで作成します。',
    );
    expect(unchosen.w.text()).not.toContain('委託会社・ファンド・版種');
    expect(unchosen.w.text()).toContain(
      '委託会社・ファンドを選択してください。版種は、片方の版だけを作るときに選びます。',
    );
  });

  it('版種を選ばず片方だけができたら、その版の編集画面へ移る', async () => {
    const { w, templates } = mountWith(both('none', 'created'), null);
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(router.push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: ID },
      query: { created: '1' },
    });
    expect(templates.generate).toHaveBeenCalledTimes(1);
  });

  it('版種を選ばずに作るときの同意文は、作る版を挙げる', async () => {
    const { w } = mountWith(both('inProgress', 'inProgress'), null);
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          '交付版・全体版の両方について、作成中のテンプレートの下書きと生成した内容を捨てて、新しく作り直します。コメントと修正履歴は残ります。',
      }),
    );
  });

  it('URL の版種(古いブックマーク)を復元したら、その版だけを作る要求になる', async () => {
    const { w, templates } = mountWith(both('none', 'none'), '交付版');
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate.mock.calls[0][0]).toMatchObject({ editionType: '交付版' });
  });
});
