// =============================================================================
// compareSideSelector.dom.test.ts — 比較の片側セレクタで、後着の古い候補が選択を潰さないこと
// =============================================================================
// 絞り込みを素早く変えると、前の条件の遅い応答が後から届く。それを反映すると表示中の条件と
// 候補が食い違い、候補が複数なら選択まで消える(`pick(null)`)。
import {
  type DropdownQuery,
  ok,
  type Result,
  type TemplateMeta,
  type TemplateVersionMeta,
} from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import Select from '@/components/ui/Select.vue';
import CompareCandidateTable from '@/features/compare/CompareCandidateTable.vue';
import CompareSideSelector from '@/features/compare/CompareSideSelector.vue';
import type { CompareCandidate } from '@/features/compare/services/compareService';
import SearchFilters from '@/features/templates/components/SearchFilters.vue';

const { listCandidates } = vi.hoisted(() => ({ listCandidates: vi.fn() }));
vi.mock('@/features/compare/services/compareService', () => ({
  useCompareService: () => ({ listCandidates }),
}));

function candidate(id: string): CompareCandidate {
  const meta = { id } as TemplateMeta;
  const version: TemplateVersionMeta = {
    historyId: `h-${id}`,
    templateId: id,
    timestamp: '2024-07-10T00:00:00Z',
    user: 'u',
    summary: '',
  };
  return { meta, versions: [version] } as CompareCandidate;
}

describe('CompareSideSelector', () => {
  it('先に撃った絞り込みの応答が後から届いても、後の絞り込みの結果と選択を上書きしない', async () => {
    let resolveSlow: (v: Result<CompareCandidate[]>) => void = () => {};
    listCandidates
      .mockImplementationOnce(
        () =>
          new Promise<Result<CompareCandidate[]>>((r) => {
            resolveSlow = r;
          }),
      )
      .mockImplementationOnce(async () => ok([candidate('B')]));

    const w = mount(CompareSideSelector, {
      global: { stubs: { SearchFilters: true, CompareCandidateTable: true } },
    });
    const filters = w.findComponent(SearchFilters);
    filters.vm.$emit('update', { companyCode: 'OLD' } as DropdownQuery);
    filters.vm.$emit('update', { companyCode: 'NEW' } as DropdownQuery);
    await flushPromises();

    resolveSlow(ok([candidate('A1'), candidate('A2')]));
    await flushPromises();

    const changes = w.emitted('change') ?? [];
    const last = changes.at(-1)?.[0] as { meta: TemplateMeta } | null;
    expect(last?.meta.id).toBe('B');
    const rows = w.findComponent(CompareCandidateTable).props('rows') as Array<{
      meta: TemplateMeta;
    }>;
    expect(rows.map((r) => r.meta.id)).toEqual(['B']);
  });

  it('候補表で版を選ぶとその版を伝え、版のプルダウンで切り替えると切り替えた版を伝える', async () => {
    const two: CompareCandidate = {
      ...candidate('A1'),
      versions: [
        { historyId: 'h-new', templateId: 'A1', timestamp: '', user: '現行版', summary: '' },
        {
          historyId: 'h-old',
          templateId: 'A1',
          timestamp: '2024-07-10T00:00:00Z',
          user: 'u',
          summary: '',
        },
      ],
    };
    listCandidates.mockReset().mockResolvedValue(ok([two, candidate('A2')]));
    const w = mount(CompareSideSelector, {
      props: { heading: 'A', side: 'a' },
      global: {
        stubs: {
          // 「比較する版」のプルダウンは絞り込み欄の slot に置かれるので、slot だけは描く。
          SearchFilters: { template: '<div><slot name="field-trailing" /></div>' },
          CompareCandidateTable: true,
        },
      },
    });
    expect(w.text()).toContain('検索してください');
    w.findComponent(SearchFilters).vm.$emit('search', {} as DropdownQuery);
    await flushPromises();
    // 候補が複数なら自動では選ばない。
    expect((w.emitted('change') ?? []).at(-1)?.[0]).toBeNull();

    w.findComponent(CompareCandidateTable).vm.$emit('select', {
      meta: two.meta,
      version: two.versions[1],
    });
    await flushPromises();
    const picked = (w.emitted('change') ?? []).at(-1)?.[0] as { version: TemplateVersionMeta };
    expect(picked.version.historyId).toBe('h-old');

    w.findComponent(Select).vm.$emit('update:modelValue', 'h-new');
    await flushPromises();
    const switched = (w.emitted('change') ?? []).at(-1)?.[0] as { version: TemplateVersionMeta };
    expect(switched.version.historyId).toBe('h-new');
  });
});
