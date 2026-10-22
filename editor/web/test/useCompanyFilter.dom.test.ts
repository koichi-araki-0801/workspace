// =============================================================================
// useCompanyFilter.dom.test.ts — テンプレート ID 先頭の略称 → 委託会社フィルタの解決
// =============================================================================
import { type CompanyOption, ok } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, type Ref, ref } from 'vue';
import { REPOS_KEY } from '@/api/repositories';
import type { CompanyFilter } from '@/features/editor/PartCatalog.vue';
import { useCompanyFilter } from '@/features/editor/useCompanyFilter';
import { resetRep1NamesForTest } from '@/lib/useRep1Names';

const COMPANIES: CompanyOption[] = [
  { companyCode: 'AM01', companyName: '会社', rep1CompanyCode: '00001' },
];

function setup(id: string, listCompanies = vi.fn(async () => ok(COMPANIES))) {
  const templateId = ref(id);
  let filter: Ref<CompanyFilter> | undefined;
  mount(
    defineComponent({
      setup() {
        filter = useCompanyFilter(templateId);
        return () => null;
      },
    }),
    { global: { provide: { [REPOS_KEY as symbol]: { templates: { listCompanies } } } } },
  );
  if (!filter) throw new Error('setup が走っていない');
  return { templateId, filter };
}

beforeEach(() => resetRep1NamesForTest());

describe('useCompanyFilter', () => {
  it('解決するまで pending、略称を Rep1 の委託会社コードへ引いて ok にする', async () => {
    const { filter } = setup('AM01_510037_20240710_交付版');
    expect(filter.value).toEqual({ state: 'pending' });
    await flushPromises();
    expect(filter.value).toEqual({ state: 'ok', code: '00001' });
  });

  it('略称が取れない ID は none', async () => {
    const { filter } = setup('規約外');
    await flushPromises();
    expect(filter.value).toEqual({ state: 'none' });
  });

  it('Rep1 に無い略称は none', async () => {
    const { filter } = setup('ZZ99_510037_20240710_交付版');
    await flushPromises();
    expect(filter.value).toEqual({ state: 'none' });
  });

  it('ID が解決中に変わったら古い結果を捨て、新しい ID の結果にする', async () => {
    let release: (v: ReturnType<typeof ok<CompanyOption[]>>) => void = () => {};
    const listCompanies = vi.fn(
      () => new Promise<ReturnType<typeof ok<CompanyOption[]>>>((r) => (release = r)),
    );
    const { templateId, filter } = setup('ZZ99_510037_20240710_交付版', listCompanies);
    templateId.value = 'AM01_510037_20240710_交付版';
    expect(filter.value).toEqual({ state: 'pending' });
    release(ok(COMPANIES));
    await flushPromises();
    expect(filter.value).toEqual({ state: 'ok', code: '00001' });
  });
});
