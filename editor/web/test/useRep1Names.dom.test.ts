// =============================================================================
// useRep1Names.dom.test.ts — 略称 → Rep1 の委託会社コード・ファンド名の解決
// =============================================================================
// 取得前・取得中・失敗の間に「未登録」と出すと、通信が不調なだけで全行が未登録に見える。
// 失敗は保持せず次の要求で取り直し、同じ会社のファンド一覧は何行あっても 1 回だけ引く。
import { type CompanyOption, err, type FundOption, ok, unexpected } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { REPOS_KEY } from '@/api/repositories';
import { resetRep1NamesForTest, useRep1Names } from '@/lib/useRep1Names';

const COMPANIES: CompanyOption[] = [
  { companyCode: 'AM01', companyName: '会社', rep1CompanyCode: '0001' },
];
const FUNDS: FundOption[] = [{ fundCode: '510037', fundName: '切替型' }];

function setup(templates: Record<string, unknown>) {
  let api: ReturnType<typeof useRep1Names> | undefined;
  mount(
    defineComponent({
      setup() {
        api = useRep1Names();
        return () => null;
      },
    }),
    { global: { provide: { [REPOS_KEY as symbol]: { templates } } } },
  );
  if (!api) throw new Error('setup が走っていない');
  return api;
}

beforeEach(() => resetRep1NamesForTest());

describe('useRep1Names', () => {
  it('取得前は略称だけ、取得後は略称（コード）', async () => {
    const api = setup({ listCompanies: vi.fn(async () => ok(COMPANIES)), listFunds: vi.fn() });
    expect(api.companyLabel('AM01')).toBe('AM01');
    api.resolveCompanies();
    await flushPromises();
    expect(api.companyLabel('AM01')).toBe('AM01（0001）');
  });

  it('略称の大文字小文字は問わない', async () => {
    const api = setup({ listCompanies: vi.fn(async () => ok(COMPANIES)), listFunds: vi.fn() });
    api.resolveCompanies();
    await flushPromises();
    expect(api.companyLabel('am01')).toBe('am01（0001）');
  });

  it('一覧に無い略称は（未登録）。そのファンドも（未登録）で listFunds を呼ばない', async () => {
    const listFunds = vi.fn();
    const api = setup({ listCompanies: vi.fn(async () => ok(COMPANIES)), listFunds });
    api.resolveFunds('ZZ99');
    await flushPromises();
    expect(api.companyLabel('ZZ99')).toBe('ZZ99（未登録）');
    expect(api.fundName('ZZ99', '510037')).toBe('（未登録）');
    expect(listFunds).not.toHaveBeenCalled();
  });

  it('会社一覧の取得失敗は未登録と出さず、次の要求で取り直す', async () => {
    const listCompanies = vi
      .fn()
      .mockResolvedValueOnce(err(unexpected('down')))
      .mockResolvedValueOnce(ok(COMPANIES));
    const api = setup({ listCompanies, listFunds: vi.fn() });
    api.resolveCompanies();
    await flushPromises();
    expect(api.companyLabel('AM01')).toBe('AM01');
    api.resolveCompanies();
    await flushPromises();
    expect(api.companyLabel('AM01')).toBe('AM01（0001）');
    expect(listCompanies).toHaveBeenCalledTimes(2);
  });

  it('ファンド名は会社単位で 1 回だけ引き、無いファンドは（未登録）', async () => {
    const listCompanies = vi.fn(async () => ok(COMPANIES));
    const listFunds = vi.fn(async () => ok(FUNDS));
    const api = setup({ listCompanies, listFunds });
    for (let i = 0; i < 100; i++) api.resolveFunds('AM01');
    await flushPromises();
    for (let i = 0; i < 100; i++) api.resolveFunds('am01');
    await flushPromises();
    expect(listCompanies).toHaveBeenCalledTimes(1);
    expect(listFunds).toHaveBeenCalledTimes(1);
    expect(listFunds).toHaveBeenCalledWith('0001');
    expect(api.fundName('AM01', '510037')).toBe('切替型');
    expect(api.fundName('AM01', '999999')).toBe('（未登録）');
  });

  it('ファンド一覧の取得失敗は空文字(コードだけ表示)で、次の要求で取り直す', async () => {
    const listFunds = vi
      .fn()
      .mockResolvedValueOnce(err(unexpected('down')))
      .mockResolvedValueOnce(ok(FUNDS));
    const api = setup({ listCompanies: vi.fn(async () => ok(COMPANIES)), listFunds });
    api.resolveFunds('AM01');
    await flushPromises();
    expect(api.fundName('AM01', '510037')).toBe('');
    api.resolveFunds('AM01');
    await flushPromises();
    expect(api.fundName('AM01', '510037')).toBe('切替型');
  });

  it('取得が例外で落ちても未登録と出さない', async () => {
    const api = setup({
      listCompanies: vi.fn(async () => {
        throw new Error('network');
      }),
      listFunds: vi.fn(),
    });
    api.resolveFunds('AM01');
    await flushPromises();
    expect(api.companyLabel('AM01')).toBe('AM01');
    expect(api.fundName('AM01', '510037')).toBe('');
  });
});

describe('useRep1Names の取得失敗からの回復', () => {
  it('会社一覧の失敗で待っていたファンドは、後の別要求で会社一覧が取れたときに引かれる', async () => {
    const listCompanies = vi
      .fn()
      .mockResolvedValueOnce(err(unexpected('down')))
      .mockResolvedValueOnce(ok(COMPANIES));
    const listFunds = vi.fn(async () => ok(FUNDS));
    const api = setup({ listCompanies, listFunds });
    api.resolveFunds('AM01'); // 表の行(マウント時に 1 回だけ要求する)
    await flushPromises();
    api.resolveCompanies(); // 別の部品からの要求
    await flushPromises();
    expect(api.fundName('AM01', '510037')).toBe('切替型');
  });

  it('ファンド一覧の失敗は、後の別要求のついでに取り直される', async () => {
    const listFunds = vi
      .fn()
      .mockResolvedValueOnce(err(unexpected('down')))
      .mockResolvedValueOnce(ok(FUNDS));
    const api = setup({ listCompanies: vi.fn(async () => ok(COMPANIES)), listFunds });
    api.resolveFunds('AM01');
    await flushPromises();
    api.resolveCompanies();
    await flushPromises();
    expect(api.fundName('AM01', '510037')).toBe('切替型');
  });
});
