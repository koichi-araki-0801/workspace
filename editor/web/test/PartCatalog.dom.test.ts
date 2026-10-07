// =============================================================================
// PartCatalog.dom.test.ts — 挿入できないページでは追加ボタンを押せず、理由をツールチップで出す
// =============================================================================
import { ok, type PartCatalogItem } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { REPOS_KEY } from '@/api/repositories';
import PartCatalog from '@/features/editor/PartCatalog.vue';

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({
    currentRoute: { value: { query: {} } },
    replace: vi.fn(() => Promise.resolve()),
  }),
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

async function mountCatalog(insertBlockedReason: string | null) {
  const parts = {
    getPartClassificationOptions: vi.fn(async () =>
      ok({ categories: ['注記'], majorClasses: [], middleClasses: [], minorClasses: [] }),
    ),
    listParts: vi.fn(async () => ok([PART])),
  };
  const w = mount(PartCatalog, {
    props: { insertBlockedReason },
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
  return w;
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
