// =============================================================================
// searchFilters.dom.test.ts — 絞り込みバーの委託会社・ファンド候補のラベル
// =============================================================================
// 候補の value は略称・コードのまま(URL クエリとカスケードの鍵)で、ラベルだけ Rep1 から
// 引いた「略称（コード）」「コード 名称」にする。
import { type DropdownOptions, err, network, ok, type Result } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import BaseDateInput from '@/components/ui/BaseDateInput.vue';
import Combobox from '@/components/ui/Combobox.vue';
import Select from '@/components/ui/Select.vue';
import SearchFilters from '@/features/templates/components/SearchFilters.vue';
import { resetRep1NamesForTest } from '@/lib/useRep1Names';

const { routeQuery } = vi.hoisted(() => ({ routeQuery: {} as Record<string, unknown> }));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => ({
    currentRoute: { value: { query: routeQuery } },
    replace: vi.fn(() => Promise.resolve()),
  }),
}));

const LABEL_OPTIONS: DropdownOptions = {
  companyCodes: ['XX01', 'ZZ99'],
  fundCodes: ['950037', '999999'],
  baseDates: [],
  editionTypes: [],
};

const templates = {
  getDropdownOptions: vi.fn(async (): Promise<Result<DropdownOptions>> => ok(LABEL_OPTIONS)),
  listCompanies: vi.fn(async () =>
    ok([{ companyCode: 'XX01', companyName: '会社', rep1CompanyCode: '0001' }]),
  ),
  listFunds: vi.fn(async () => ok([{ fundCode: '950037', fundName: '切替型' }])),
};

beforeEach(() => {
  resetRep1NamesForTest();
  templates.getDropdownOptions.mockReset();
  templates.getDropdownOptions.mockImplementation(async () => ok(LABEL_OPTIONS));
  for (const k of Object.keys(routeQuery)) {
    delete routeQuery[k];
  }
});

describe('SearchFilters の候補ラベル', () => {
  it('委託会社は略称（コード）、ファンドは選択中の会社の Rep1 の名前', async () => {
    routeQuery.companyCode = 'XX01';
    const w = mount(SearchFilters, {
      props: { dropdownScope: 'edit' },
      global: { provide: { [REPOS_KEY as symbol]: { templates } } },
    });
    await flushPromises();
    expect(w.text()).toContain('委託会社');
    expect(w.text()).not.toContain('委託会社コード');
    const [company, fund] = w.findAllComponents(Combobox);
    expect(company.props('options')).toEqual([
      { label: 'XX01（0001）', value: 'XX01' },
      { label: 'ZZ99（未登録）', value: 'ZZ99' },
    ]);
    expect(fund.props('options')).toEqual([
      { label: '950037 切替型', value: '950037' },
      { label: '999999 （未登録）', value: '999999' },
    ]);
  });
});

const REJECT_TEXT = 'この基準日の承認済みテンプレートはありません';
const CREATE_TAB_TEXT = '作成済みのテンプレートがありません。先に作成タブで作成してください';

function optionsWith(editionTypes: string[]): DropdownOptions {
  return { companyCodes: ['XX01'], fundCodes: ['950037'], baseDates: ['20240710'], editionTypes };
}

function mountFilters(props: Record<string, unknown> = {}) {
  return mount(SearchFilters, {
    props: { dropdownScope: 'published', ...props },
    global: { provide: { [REPOS_KEY as symbol]: { templates } } },
  });
}

async function commitBaseDate(w: ReturnType<typeof mountFilters>, value: string): Promise<void> {
  const input = w.findComponent(BaseDateInput).find('input');
  await input.setValue(value);
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
}

function editionSelect(w: ReturnType<typeof mountFilters>) {
  return w.findAllComponents(Select).at(-1);
}

function searchButton(w: ReturnType<typeof mountFilters>) {
  const b = w.findAll('button').find((x) => x.text().includes('検索'));
  if (!b) {
    throw new Error('検索ボタンが無い');
  }
  return b;
}

describe('SearchFilters の基準日の段', () => {
  beforeEach(() => {
    routeQuery.companyCode = 'XX01';
    routeQuery.fundCode = '950037';
  });

  it('reject: unknown date disables edition and search', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters();
    await flushPromises();
    await commitBaseDate(w, '20261110');
    expect(w.text()).toContain(REJECT_TEXT);
    expect(editionSelect(w)?.props('disabled')).toBe(true);
    expect(searchButton(w).attributes('disabled')).toBeDefined();
  });

  it('reject: unknownDateText で文言を差し替えられる', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters({ unknownDateText: 'この基準日のテンプレートはありません' });
    await flushPromises();
    await commitBaseDate(w, '2026/11/10');
    expect(w.text()).toContain('この基準日のテンプレートはありません');
    expect(w.text()).not.toContain(REJECT_TEXT);
  });

  it('reject: 候補にある日付なら案内を出さない', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters();
    await flushPromises();
    await commitBaseDate(w, '2024/07/10');
    expect(w.text()).not.toContain(REJECT_TEXT);
    expect(editionSelect(w)?.props('disabled')).toBe(false);
    expect(searchButton(w).attributes('disabled')).toBeUndefined();
  });

  it('unreadable retype disables edition and search', async () => {
    // 確定済みの基準日を読めない文字に打ち直すと、欄に誤りが出たまま前の基準日で進めてしまう。
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters();
    await flushPromises();
    await commitBaseDate(w, '2024/07/10');
    editionSelect(w)?.vm.$emit('update:modelValue', '全体版');
    await flushPromises();
    expect(searchButton(w).attributes('disabled')).toBeUndefined();

    const input = w.findComponent(BaseDateInput).find('input');
    await input.setValue('2024/13/01');
    await input.trigger('blur');
    await flushPromises();
    expect(w.text()).toContain('実在しない日付です');
    expect(editionSelect(w)?.props('disabled')).toBe(true);
    expect(searchButton(w).attributes('disabled')).toBeDefined();
  });

  it('allow: unknown date keeps edition enabled', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters({ dropdownScope: 'edit', newBaseDate: 'allow' });
    await flushPromises();
    await commitBaseDate(w, '20261110');
    expect(w.text()).not.toContain(REJECT_TEXT);
    expect(w.text()).not.toContain(CREATE_TAB_TEXT);
    expect(editionSelect(w)?.props('disabled')).toBe(false);
  });

  it('allow: no edition shows create-tab notice', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith([])));
    const w = mountFilters({ dropdownScope: 'edit', newBaseDate: 'allow' });
    await flushPromises();
    await commitBaseDate(w, '20261110');
    expect(w.text()).toContain(CREATE_TAB_TEXT);
    expect(w.text()).not.toContain(REJECT_TEXT);
  });

  it('allow: 版種の候補を取り直している間は作成タブの案内を出さない', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith([])));
    const w = mountFilters({ dropdownScope: 'edit', newBaseDate: 'allow' });
    await flushPromises();
    templates.getDropdownOptions.mockImplementation(() => new Promise(() => {}));
    await commitBaseDate(w, '20261110');
    expect(w.text()).not.toContain(CREATE_TAB_TEXT);
  });

  it('restore guard (reject)', async () => {
    routeQuery.baseDate = '20261110';
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters();
    await flushPromises();
    expect(w.emitted('restore')).toBeUndefined();
    expect(w.text()).toContain(REJECT_TEXT);
  });

  it('reject: 候補の取得に失敗したときは案内を出さず、restore も出さない', async () => {
    routeQuery.baseDate = '20240710';
    templates.getDropdownOptions.mockImplementation(async () => err(network('取得に失敗しました')));
    const w = mountFilters();
    await flushPromises();
    expect(w.text()).not.toContain(REJECT_TEXT);
    expect(w.emitted('restore')).toBeUndefined();
  });

  it('reject: 候補の取得に失敗しても、基準日の無い復元は restore を出す', async () => {
    templates.getDropdownOptions.mockImplementation(async () => err(network('取得に失敗しました')));
    const w = mountFilters();
    await flushPromises();
    expect(w.emitted('restore')).toHaveLength(1);
  });

  it('allow: 候補の取得に失敗しても restore を出す', async () => {
    routeQuery.baseDate = '20261110';
    templates.getDropdownOptions.mockImplementation(async () => err(network('取得に失敗しました')));
    const w = mountFilters({ dropdownScope: 'edit', newBaseDate: 'allow' });
    await flushPromises();
    expect(w.emitted('restore')).toHaveLength(1);
  });

  it('reject: 候補に無い日付では update から基準日と版種を外す', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters();
    await flushPromises();
    await commitBaseDate(w, '20240710');
    expect(w.emitted('update')?.at(-1)).toEqual([
      { companyCode: 'XX01', fundCode: '950037', baseDate: '20240710', editionType: undefined },
    ]);
    await commitBaseDate(w, '20261110');
    const last = w.emitted('update')?.at(-1)?.[0] as Record<string, unknown>;
    expect(last).toEqual({ companyCode: 'XX01', fundCode: '950037' });
    expect('baseDate' in last).toBe(false);
    expect('editionType' in last).toBe(false);
  });

  it('allow: 候補に無い日付でも update に基準日を載せる', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters({ dropdownScope: 'edit', newBaseDate: 'allow' });
    await flushPromises();
    await commitBaseDate(w, '20261110');
    expect(w.emitted('update')?.at(-1)?.[0]).toMatchObject({ baseDate: '20261110' });
  });

  it('案内と入力の誤りは基準日の段の外(全幅の行)に出す', async () => {
    templates.getDropdownOptions.mockImplementation(async () => ok(optionsWith(['全体版'])));
    const w = mountFilters();
    await flushPromises();
    const field = w.findComponent(BaseDateInput).element.parentElement as HTMLElement;
    await commitBaseDate(w, '2026093');
    const alert = w.find('[role="alert"]');
    expect(alert.text()).toBe('日付として読めません（例: 2026/09/30）');
    expect(field.contains(alert.element)).toBe(false);
    expect(alert.element.parentElement?.classList.contains('basis-full')).toBe(true);
    await commitBaseDate(w, '20261110');
    const status = w.find('[role="status"]');
    expect(status.text()).toBe(REJECT_TEXT);
    expect(field.contains(status.element)).toBe(false);
    expect(status.element.parentElement?.classList.contains('basis-full')).toBe(true);
  });

  it('古い候補の応答が成功しても、反映前の空の候補で案内を出さない', async () => {
    routeQuery.baseDate = '20240710';
    const resolvers: Array<(r: Result<DropdownOptions>) => void> = [];
    templates.getDropdownOptions.mockImplementation(
      () =>
        new Promise<Result<DropdownOptions>>((r) => {
          resolvers.push(r);
        }),
    );
    const w = mountFilters();
    await flushPromises();
    editionSelect(w)?.vm.$emit('update:modelValue', '全体版');
    await flushPromises();
    expect(resolvers).toHaveLength(2);
    resolvers[0](ok(optionsWith(['全体版'])));
    await flushPromises();
    expect(w.text()).not.toContain(REJECT_TEXT);
    resolvers[1](ok(optionsWith(['全体版'])));
    await flushPromises();
    expect(w.text()).not.toContain(REJECT_TEXT);
  });

  it('restore guard (allow)', async () => {
    routeQuery.baseDate = '20261110';
    let resolve: (r: Result<DropdownOptions>) => void = () => {};
    templates.getDropdownOptions.mockImplementation(
      () =>
        new Promise<Result<DropdownOptions>>((r) => {
          resolve = r;
        }),
    );
    const w = mountFilters({ dropdownScope: 'edit', newBaseDate: 'allow' });
    await flushPromises();
    expect(w.emitted('restore')).toBeUndefined();
    resolve(ok(optionsWith(['全体版'])));
    await flushPromises();
    expect(w.emitted('restore')).toEqual([
      [{ companyCode: 'XX01', fundCode: '950037', baseDate: '20261110' }],
    ]);
  });

  it('restore waits for options', async () => {
    routeQuery.baseDate = '20240710';
    let resolve: (r: Result<DropdownOptions>) => void = () => {};
    templates.getDropdownOptions.mockImplementation(
      () =>
        new Promise<Result<DropdownOptions>>((r) => {
          resolve = r;
        }),
    );
    const w = mountFilters();
    await flushPromises();
    expect(w.text()).not.toContain(REJECT_TEXT);
    expect(w.emitted('restore')).toBeUndefined();
    resolve(ok(optionsWith(['全体版'])));
    await flushPromises();
    expect(w.emitted('restore')).toEqual([
      [{ companyCode: 'XX01', fundCode: '950037', baseDate: '20240710' }],
    ]);
    expect(templates.getDropdownOptions).toHaveBeenCalledTimes(1);
  });
});
