// =============================================================================
// fundCodeName.dom.test.ts — 委託会社・ファンド名の共有表示部品が Rep1 から引くこと
// =============================================================================
// ファンド名はサンプルデータ(台帳)ではなく Rep1(`listFunds`)から引く。台帳に無いファンドに
// 既定の「サンプルファンド」が名前として出ていたのを防ぐ。
import { ok } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import AttributeBar from '@/components/AttributeBar.vue';
import CompanyCodeLabel from '@/components/CompanyCodeLabel.vue';
import FundCodeName from '@/components/FundCodeName.vue';
import EditorTopBar from '@/features/editor/EditorTopBar.vue';
import { resetRep1NamesForTest } from '@/lib/useRep1Names';

const templates = {
  listCompanies: vi.fn(async () =>
    ok([{ companyCode: 'AM01', companyName: '会社', rep1CompanyCode: '0001' }]),
  ),
  listFunds: vi.fn(async () => ok([{ fundCode: '510037', fundName: '切替型' }])),
  getSampleData: vi.fn(),
};
const provide = { [REPOS_KEY as symbol]: { templates } };

beforeEach(() => {
  resetRep1NamesForTest();
  vi.clearAllMocks();
});

describe('FundCodeName / CompanyCodeLabel', () => {
  it('Rep1 のファンド名を出し、サンプルデータは引かない', async () => {
    const w = mount(FundCodeName, {
      props: { companyCode: 'AM01', code: '510037' },
      global: { provide },
    });
    await flushPromises();
    expect(w.text()).toBe('510037切替型');
    expect(templates.getSampleData).not.toHaveBeenCalled();
  });

  it('Rep1 に無いファンドは（未登録）', async () => {
    const w = mount(FundCodeName, {
      props: { companyCode: 'AM01', code: '999999' },
      global: { provide },
    });
    await flushPromises();
    expect(w.text()).toBe('999999（未登録）');
  });

  it('委託会社は略称（コード）', async () => {
    const w = mount(CompanyCodeLabel, { props: { code: 'AM01' }, global: { provide } });
    await flushPromises();
    expect(w.text()).toBe('AM01（0001）');
  });

  it('属性欄は委託会社を略称（コード）、ファンドをコード＋名前で出す', async () => {
    const w = mount(AttributeBar, {
      props: {
        attributes: {
          companyCode: 'AM01',
          fundCode: '510037',
          baseDate: '20240710',
          editionType: '交付版',
        },
      },
      global: { provide },
    });
    await flushPromises();
    expect(w.text()).toContain('委託会社AM01（0001）');
    expect(w.text()).toContain('510037切替型');
  });
});

describe('EditorTopBar のタイトルと委託会社', () => {
  const base = {
    fundName: 'AM01_510037_20240710_交付版',
    dirty: false,
    saveState: 'idle',
    statusText: '',
    zoom: 1,
    canUndo: false,
    canRedo: false,
    showPageGuides: false,
    showRedline: false,
    redlineAvailable: false,
    currentPage: 1,
    pageCount: 1,
    singlePageMode: false,
    allowEdit: false,
  };
  const stubs = { BackButton: true, PageNav: true, Tooltip: { template: '<span><slot /></span>' } };

  async function mountBar(fundCode: string) {
    const w = mount(EditorTopBar, {
      props: {
        ...base,
        attributes: { companyCode: 'AM01', fundCode, baseDate: '20240710', editionType: '交付版' },
      } as never,
      global: { provide, stubs },
    });
    await flushPromises();
    return w;
  }

  it('タイトルは Rep1 のファンド名、委託会社チップは略称（コード）', async () => {
    const w = await mountBar('510037');
    expect(w.text()).toContain('切替型');
    expect(w.text()).not.toContain('AM01_510037_20240710_交付版');
    expect(w.text()).toContain('委託会社AM01（0001）');
  });

  it('Rep1 に無いファンドのタイトルは（未登録）でなく既定(ファイル名)', async () => {
    const w = await mountBar('999999');
    expect(w.text()).toContain('AM01_510037_20240710_交付版');
  });
});
