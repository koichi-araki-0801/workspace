// =============================================================================
// CreateFundSelect.dom.test.ts — 作成タブ Step 1 の連動プルダウンが親へ伝える選択
// =============================================================================
// 親(CreateTabView)は `update` だけで選択を知る。会社を変えたのに通知が取得完了まで遅れたり、
// 取得失敗で通知が欠けたりすると、Step 2 が前の会社・ファンドのまま押せてしまう。
// URL から復元した会社コードは候補の綴り(略称)へそろえ、Rep1 のコードを付けて伝える。
import { type CompanyOption, err, type FundOption, ok, unexpected } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import Combobox from '@/components/ui/Combobox.vue';
import Select from '@/components/ui/Select.vue';
import CreateFundSelect, {
  type CreateFundSelection,
} from '@/features/templates/components/CreateFundSelect.vue';

const { routeQuery, router } = vi.hoisted(() => {
  const routeQuery: Record<string, unknown> = {};
  const router = {
    currentRoute: { value: { query: {} as Record<string, unknown> } },
    replace: vi.fn(() => Promise.resolve()),
  };
  return { routeQuery, router };
});
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => router,
}));
vi.mock('@/components/ui/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const COMPANIES: CompanyOption[] = [
  { companyCode: 'XX01', companyName: '会社 1', rep1CompanyCode: 'R-XX01' },
  { companyCode: 'XX02', companyName: '会社 2', rep1CompanyCode: 'R-XX02' },
];
const FUNDS: FundOption[] = [{ fundCode: '950037', fundName: 'ファンド' }];

beforeEach(() => {
  for (const k of Object.keys(routeQuery)) delete routeQuery[k];
});

function mountWith(listFunds: (rep1: string) => Promise<unknown>) {
  const templates = {
    listCompanies: vi.fn(async () => ok(COMPANIES)),
    listFunds: vi.fn(listFunds),
  };
  const w = mount(CreateFundSelect, {
    global: { provide: { [REPOS_KEY as symbol]: { templates } } },
  });
  const last = (): CreateFundSelection => {
    const events = w.emitted('update') ?? [];
    return (events[events.length - 1]?.[0] ?? {}) as CreateFundSelection;
  };
  return { w, templates, last };
}

/** 委託会社の Combobox で値を選んだことにする(v-model の更新と @update:model-value の両方)。 */
async function chooseCompany(w: ReturnType<typeof mount>, value: string) {
  const company = w.findAllComponents(Combobox)[0];
  company.vm.$emit('update:modelValue', value);
  await flushPromises();
}

describe('CreateFundSelect', () => {
  it('委託会社の候補は「略称（Rep1 のコード）」で、正式名は出さない', async () => {
    const { w } = mountWith(async () => ok(FUNDS));
    await flushPromises();
    const company = w.findAllComponents(Combobox)[0];
    expect(company.props('options')).toEqual([
      { label: 'XX01（R-XX01）', value: 'XX01' },
      { label: 'XX02（R-XX02）', value: 'XX02' },
    ]);
    expect(w.text()).not.toContain('会社 1');
  });

  it('会社を変えたら、ファンドの取得を待たずにファンドと版種を消した選択を伝える', async () => {
    Object.assign(routeQuery, { companyCode: 'XX01', fundCode: '950037', editionType: '交付版' });
    let releaseXx02: (v: unknown) => void = () => {};
    const { w, last } = mountWith((rep1) =>
      rep1 === 'R-XX02'
        ? new Promise((resolve) => {
            releaseXx02 = resolve;
          })
        : Promise.resolve(ok(FUNDS)),
    );
    await flushPromises();
    expect(last()).toMatchObject({
      companyCode: 'XX01',
      fundCode: '950037',
      editionType: '交付版',
    });

    await chooseCompany(w, 'XX02');
    expect(last()).toMatchObject({ companyCode: 'XX02', rep1CompanyCode: 'R-XX02' });
    expect(last().fundCode).toBeUndefined();
    expect(last().editionType).toBeUndefined();
    releaseXx02(ok([]));
    await flushPromises();
  });

  it('ファンドの取得に失敗しても、ファンドと版種を消した選択を伝える', async () => {
    Object.assign(routeQuery, { companyCode: 'XX01', fundCode: '950037', editionType: '交付版' });
    const { w, last } = mountWith((rep1) =>
      Promise.resolve(rep1 === 'R-XX02' ? err(unexpected('DB 不達')) : ok(FUNDS)),
    );
    await flushPromises();
    await chooseCompany(w, 'XX02');
    expect(last().companyCode).toBe('XX02');
    expect(last().fundCode).toBeUndefined();
  });

  it('URL の会社コードの大文字小文字は候補の綴り(略称)へそろえ、Rep1 のコードを付ける', async () => {
    Object.assign(routeQuery, { companyCode: 'xx01', fundCode: '950037', editionType: '交付版' });
    const { last } = mountWith(async () => ok(FUNDS));
    await flushPromises();
    expect(last()).toMatchObject({ companyCode: 'XX01', rep1CompanyCode: 'R-XX01' });
  });

  it('取得中に候補に無い会社へ変えたら、前の会社のファンドが後から届いても候補へ載せない', async () => {
    let releaseXx02: (v: unknown) => void = () => {};
    const { w } = mountWith(
      () =>
        new Promise((resolve) => {
          releaseXx02 = resolve;
        }),
    );
    await flushPromises();
    await chooseCompany(w, 'XX02');
    await chooseCompany(w, 'ZZ99');
    releaseXx02(ok(FUNDS));
    await flushPromises();
    expect(w.findAllComponents(Combobox)[1].props('options')).toEqual([]);
    expect(w.find('.animate-spin').exists()).toBe(false);
  });

  it('取得中にクリアしたら、前の会社のファンドが後から届いても候補へ載せない', async () => {
    let releaseXx02: (v: unknown) => void = () => {};
    const { w } = mountWith(
      () =>
        new Promise((resolve) => {
          releaseXx02 = resolve;
        }),
    );
    await flushPromises();
    await chooseCompany(w, 'XX02');
    await w
      .findAll('button')
      .find((b) => b.text().includes('クリア'))
      ?.trigger('click');
    releaseXx02(ok(FUNDS));
    await flushPromises();
    expect(w.findAllComponents(Combobox)[1].props('options')).toEqual([]);
    expect(w.find('.animate-spin').exists()).toBe(false);
  });
});

describe('CreateFundSelect の版種(任意)', () => {
  it('版種のラベルは「版種（任意）」で必須の印が無く、未選択は「選ばない（両版を作る）」と出る', async () => {
    const { w } = mountWith(async () => ok(FUNDS));
    await flushPromises();
    expect(w.text()).toContain('版種（任意）');
    expect(w.findComponent(Select).props('placeholder')).toBe('選ばない（両版を作る）');
    const label = w.findAll('label').find((l) => l.text().includes('版種'));
    expect(label?.text()).not.toContain('*');
  });

  it('「選ばない（両版を作る）」を選ぶと、editionType を外した選択を伝え、表示は未選択に戻る', async () => {
    Object.assign(routeQuery, { companyCode: 'XX01', fundCode: '950037' });
    const { w, last } = mountWith(async () => ok(FUNDS));
    await flushPromises();
    const select = w.findComponent(Select);
    select.vm.$emit('update:modelValue', '交付版');
    await flushPromises();
    expect(last().editionType).toBe('交付版');
    select.vm.$emit('update:modelValue', 'both');
    await flushPromises();
    expect(last().editionType).toBeUndefined();
    expect(w.findComponent(Select).props('modelValue')).toBe('both');
  });

  it('URL の版種を復元すると、その版が選ばれた表示になる', async () => {
    Object.assign(routeQuery, { companyCode: 'XX01', fundCode: '950037', editionType: '全体版' });
    const { w, last } = mountWith(async () => ok(FUNDS));
    await flushPromises();
    expect(w.findComponent(Select).props('modelValue')).toBe('全体版');
    expect(last().editionType).toBe('全体版');
  });
});
