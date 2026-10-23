// =============================================================================
// searchFilters.dom.test.ts — 絞り込みバーの委託会社・ファンド候補のラベル
// =============================================================================
// 候補の value は略称・コードのまま(URL クエリとカスケードの鍵)で、ラベルだけ Rep1 から
// 引いた「略称（コード）」「コード 名称」にする。
import { ok } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import Combobox from '@/components/ui/Combobox.vue';
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

const templates = {
  getDropdownOptions: vi.fn(async () =>
    ok({
      companyCodes: ['AM01', 'ZZ99'],
      fundCodes: ['510037', '999999'],
      baseDates: [],
      editionTypes: [],
    }),
  ),
  listCompanies: vi.fn(async () =>
    ok([{ companyCode: 'AM01', companyName: '会社', rep1CompanyCode: '0001' }]),
  ),
  listFunds: vi.fn(async () => ok([{ fundCode: '510037', fundName: '切替型' }])),
};

beforeEach(() => {
  resetRep1NamesForTest();
  for (const k of Object.keys(routeQuery)) delete routeQuery[k];
});

describe('SearchFilters の候補ラベル', () => {
  it('委託会社は略称（コード）、ファンドは選択中の会社の Rep1 の名前', async () => {
    routeQuery.companyCode = 'AM01';
    const w = mount(SearchFilters, {
      props: { dropdownScope: 'edit' },
      global: { provide: { [REPOS_KEY as symbol]: { templates } } },
    });
    await flushPromises();
    expect(w.text()).toContain('委託会社');
    expect(w.text()).not.toContain('委託会社コード');
    const [company, fund] = w.findAllComponents(Combobox);
    expect(company.props('options')).toEqual([
      { label: 'AM01（0001）', value: 'AM01' },
      { label: 'ZZ99（未登録）', value: 'ZZ99' },
    ]);
    expect(fund.props('options')).toEqual([
      { label: '510037 切替型', value: '510037' },
      { label: '999999 （未登録）', value: '999999' },
    ]);
  });
});
