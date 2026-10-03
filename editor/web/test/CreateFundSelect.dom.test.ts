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
  { companyCode: 'AM01', companyName: '会社 1', rep1CompanyCode: 'R-AM01' },
  { companyCode: 'AM02', companyName: '会社 2', rep1CompanyCode: 'R-AM02' },
];
const FUNDS: FundOption[] = [{ fundCode: '510037', fundName: 'ファンド' }];

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
  it('会社を変えたら、ファンドの取得を待たずにファンドと版種を消した選択を伝える', async () => {
    Object.assign(routeQuery, { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' });
    let releaseAm02: (v: unknown) => void = () => {};
    const { w, last } = mountWith((rep1) =>
      rep1 === 'R-AM02'
        ? new Promise((resolve) => {
            releaseAm02 = resolve;
          })
        : Promise.resolve(ok(FUNDS)),
    );
    await flushPromises();
    expect(last()).toMatchObject({
      companyCode: 'AM01',
      fundCode: '510037',
      editionType: '交付版',
    });

    await chooseCompany(w, 'AM02');
    expect(last()).toMatchObject({ companyCode: 'AM02', rep1CompanyCode: 'R-AM02' });
    expect(last().fundCode).toBeUndefined();
    expect(last().editionType).toBeUndefined();
    releaseAm02(ok([]));
    await flushPromises();
  });

  it('ファンドの取得に失敗しても、ファンドと版種を消した選択を伝える', async () => {
    Object.assign(routeQuery, { companyCode: 'AM01', fundCode: '510037', editionType: '交付版' });
    const { w, last } = mountWith((rep1) =>
      Promise.resolve(rep1 === 'R-AM02' ? err(unexpected('DB 不達')) : ok(FUNDS)),
    );
    await flushPromises();
    await chooseCompany(w, 'AM02');
    expect(last().companyCode).toBe('AM02');
    expect(last().fundCode).toBeUndefined();
  });

  it('URL の会社コードの大文字小文字は候補の綴り(略称)へそろえ、Rep1 のコードを付ける', async () => {
    Object.assign(routeQuery, { companyCode: 'am01', fundCode: '510037', editionType: '交付版' });
    const { last } = mountWith(async () => ok(FUNDS));
    await flushPromises();
    expect(last()).toMatchObject({ companyCode: 'AM01', rep1CompanyCode: 'R-AM01' });
  });
});
