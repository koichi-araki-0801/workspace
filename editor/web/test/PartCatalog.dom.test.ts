// =============================================================================
// PartCatalog.dom.test.ts — 挿入できないページでは追加ボタンを押せず、理由をツールチップで出す
// =============================================================================
import { ok, type PartCatalogItem } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import PartCatalog from '@/features/editor/PartCatalog.vue';

const { replace } = vi.hoisted(() => ({ replace: vi.fn(() => Promise.resolve()) }));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ currentRoute: { value: { query: {} } }, replace }),
}));

const PART: PartCatalogItem = {
  id: 'p1',
  classification: { category: '注記', majorClass: 'a', middleClass: 'b', minorClass: 'c' },
  name: '注記',
  description: '説明',
  usageNotes: '',
  updatedAt: null,
  updatedBy: null,
  content: '<p>注</p>',
};

async function mountCatalog(insertBlockedReason: string | null, editionType?: string | null) {
  const parts = {
    getPartClassificationOptions: vi.fn(async () =>
      ok({ categories: ['注記'], majorClasses: [], middleClasses: [], minorClasses: [] }),
    ),
    listParts: vi.fn(async () => ok([PART])),
  };
  const w = mount(PartCatalog, {
    props: { insertBlockedReason, editionType },
    global: {
      provide: { [REPOS_KEY as symbol]: { parts } },
      stubs: {
        PartPreview: true,
        Tooltip: {
          props: ['text', 'disabled'],
          template: '<span :data-tip="disabled ? undefined : text"><slot /></span>',
        },
      },
    },
  });
  await flushPromises();
  return Object.assign(w, { parts });
}

const insertButton = (w: Awaited<ReturnType<typeof mountCatalog>>) =>
  w.get('button[aria-label="選択したパーツを挿入"]');

describe('PartCatalog の追加ボタン', () => {
  it('挿入できないページでは押せず、理由をツールチップで出し、押しても挿入しない', async () => {
    const w = await mountCatalog('このページには挿入できません');
    expect(insertButton(w).attributes('disabled')).toBeDefined();
    expect(w.find('[data-tip]').attributes('data-tip')).toBe('このページには挿入できません');
    await insertButton(w).trigger('click');
    expect(w.emitted('insert')).toBeUndefined();
  });

  it('挿入できるページでは押せて、ツールチップを出さない', async () => {
    const w = await mountCatalog(null);
    expect(insertButton(w).attributes('disabled')).toBeUndefined();
    expect(w.find('[data-tip]').exists()).toBe(false);
    await insertButton(w).trigger('click');
    expect(w.emitted('insert')).toEqual([[PART]]);
  });
});

describe('PartCatalog の版種', () => {
  it('版種を渡すと分類候補と一覧の取得に editionType を付ける', async () => {
    const w = await mountCatalog(null, '交付版');
    expect(w.parts.getPartClassificationOptions).toHaveBeenCalledWith({ editionType: '交付版' });
    expect(w.parts.listParts).toHaveBeenCalledWith({ editionType: '交付版' });
  });

  it('版種が空・null・未指定なら editionType を付けない', async () => {
    for (const e of ['', null, undefined]) {
      const w = await mountCatalog(null, e);
      expect(w.parts.listParts).toHaveBeenCalledWith({});
      expect(w.parts.getPartClassificationOptions).toHaveBeenCalledWith({});
    }
  });

  it('版種は URL クエリへ載せない', async () => {
    replace.mockClear();
    await mountCatalog(null, '交付版');
    const written = JSON.stringify(replace.mock.calls);
    expect(written).not.toMatch(/edition|交付版/i);
  });

  it('prop を変えると取り直す', async () => {
    const w = await mountCatalog(null, '交付版');
    w.parts.listParts.mockClear();
    w.parts.getPartClassificationOptions.mockClear();
    await w.setProps({ editionType: '全体版' });
    await flushPromises();
    expect(w.parts.getPartClassificationOptions).toHaveBeenCalledWith({ editionType: '全体版' });
    expect(w.parts.listParts).toHaveBeenCalledWith({ editionType: '全体版' });
  });

  it('prop を変えると選択中の分類を解いてから取り直す', async () => {
    const w = await mountCatalog(null, '交付版');
    const vm = w.vm as unknown as { query: { category?: string } };
    vm.query.category = '注記';
    w.parts.listParts.mockClear();
    await w.setProps({ editionType: '全体版' });
    await flushPromises();
    expect(w.parts.listParts).toHaveBeenCalledWith({ editionType: '全体版' });
    expect(w.parts.listParts).not.toHaveBeenCalledWith(
      expect.objectContaining({ category: '注記' }),
    );
  });
});
