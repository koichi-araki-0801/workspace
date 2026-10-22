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
  { companyCode: 'AM01', companyName: '会社 1', rep1CompanyCode: 'R-AM01' },
];
const FUNDS: FundOption[] = [{ fundCode: '510037', fundName: 'ファンド' }];
const SERIES = [{ fundCode: '510003', fundName: '安定型', hasTemplate: true }];
const ID = 'AM01_510037_交付版';

function mountWith(info: CreatableInfo) {
  Object.assign(routeQuery, { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' });
  const templates = {
    listCompanies: vi.fn(async () => ok(COMPANIES)),
    listFunds: vi.fn(async () => ok(FUNDS)),
    getCreatableInfo: vi.fn(async () => ok(info)),
    generate: vi.fn(async () =>
      ok({
        template: {
          meta: {
            id: ID,
            attributes: { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' },
            fileName: `${ID}.html`,
            status: 'draft',
            updatedAt: null,
            updatedBy: null,
          },
          html: '',
          css: '',
          filled: '',
        },
        importedIds: [ID],
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
    const { w, templates } = mountWith({ created: true, templateId: ID, seriesFunds: SERIES });
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

  it('作成中なら「作成中のテンプレートを開く」で作成経路の編集画面を開く', async () => {
    const { w } = mountWith({ created: false, inProgressId: ID, seriesFunds: SERIES });
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
    const { w, templates } = mountWith({ created: false, inProgressId: ID, seriesFunds: [] });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '作業中の内容を捨てて作り直しますか' }),
    );
    expect(templates.generate).not.toHaveBeenCalled();
  });

  it('作成中の作り直しに同意すると replaceExisting で生成し、作成経路の編集画面へ進む', async () => {
    const { w, templates } = mountWith({ created: false, inProgressId: ID, seriesFunds: [] });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.objectContaining({ fundCode: '510037', replaceExisting: true }),
    );
    expect(router.push).toHaveBeenCalledWith({
      name: 'editor',
      params: { id: ID },
      query: { created: '1' },
    });
  });

  it('作り直しの確認文は交付版・全体版の両方を捨てることを伝える', async () => {
    const { w } = mountWith({ created: false, inProgressId: ID, seriesFunds: [] });
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

  it('生成の要求に Rep1 の会社コードを載せる', async () => {
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.objectContaining({ rep1CompanyCode: 'R-AM01' }),
    );
  });

  it('基準日は空欄が既定で、空のままなら要求に baseDate を載せない', async () => {
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
    await settle();
    const input = w.find('input[type="date"]');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('');
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledWith(expect.not.objectContaining({ baseDate: '' }));
    expect(templates.generate.mock.calls[0][0]).not.toHaveProperty('baseDate');
  });

  it('基準日を入れると、要求にその値を載せる', async () => {
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
    await settle();
    await w.find('input[type="date"]').setValue('2026-10-01');
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).toHaveBeenCalledWith(
      expect.objectContaining({ baseDate: '2026-10-01' }),
    );
  });

  it('基準日の入力欄は日本時間の今日を max にする', async () => {
    const { w } = mountWith({ created: false, seriesFunds: [] });
    await settle();
    expect(w.find('input[type="date"]').attributes('max')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('今日より後の基準日は誤りを出し、生成しない', async () => {
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
    await settle();
    await w.find('input[type="date"]').setValue('2999-01-01');
    expect(w.text()).toContain('基準日は今日より後にできません');
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(templates.generate).not.toHaveBeenCalled();
  });

  it('取り込まなかった組入先があれば、飛ばした id を並べて知らせる', async () => {
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
    const first = await templates.generate();
    templates.generate.mockResolvedValueOnce(
      ok({
        ...(first as { value: object }).value,
        skipped: [
          { templateId: 'AM01_510003_交付版', reason: 'created' },
          { templateId: 'AM01_510155_全体版', reason: 'pendingReview' },
        ],
      }) as never,
    );
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(toastMock).toHaveBeenCalledWith(
      '組入先の次のテンプレートは既にあるため取り込みませんでした: AM01_510003_交付版、AM01_510155_全体版',
    );
  });

  it('飛ばした組入先が無ければ、その通知は出さない', async () => {
    const { w } = mountWith({ created: false, seriesFunds: [] });
    await settle();
    await buttonNamed(w, '属性から新規作成')?.trigger('click');
    await settle();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('作成済みでも作成中でもなければ、確認せずに生成し「開く」ボタンは出ない', async () => {
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
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
    const { w, templates } = mountWith({ created: false, seriesFunds: [] });
    templates.getCreatableInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as never,
    );
    await settle();
    const select = w.findComponent(CreateFundSelect);
    select.vm.$emit('update', {
      companyCode: 'AM01',
      rep1CompanyCode: 'R-AM01',
      fundCode: '510099',
      editionType: '交付版',
    });
    await settle();
    select.vm.$emit('update', {
      companyCode: 'AM01',
      rep1CompanyCode: 'R-AM01',
      fundCode: undefined,
      editionType: undefined,
    });
    await settle();
    release(ok({ created: false, seriesFunds: SERIES }));
    await settle();
    // 前の属性(510099)のシリーズ候補で「シリーズから作成」カードが現れない。
    expect(buttonNamed(w, '既存のシリーズを元に作成')).toBeUndefined();
  });
});
