import { mount } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { DEFAULT_GEOM } from '@/features/editor/geom';
import type { HistoryGroup } from '@/features/editor/historyGroups';
import Inspector from '@/features/editor/Inspector.vue';

const entry = (id: string, partKey: string) => ({
  id,
  partKey,
  change: `変更${id}`,
  timestamp: '2026-10-28T00:00:00Z',
  user: '太郎',
});
const groups: HistoryGroup[] = [
  {
    key: 'a',
    no: 1,
    name: '概況',
    removed: false,
    offCanvas: false,
    entries: [entry('1', 'a')],
    rejected: null,
  },
  {
    key: 'b',
    no: 2,
    name: '旧表（削除）',
    removed: true,
    offCanvas: false,
    entries: [],
    rejected: null,
  },
  {
    key: 'c',
    no: null,
    name: '注記',
    removed: false,
    offCanvas: false,
    entries: [entry('3', 'c')],
    rejected: null,
  },
];

function mountInspector(over: Record<string, unknown> = {}) {
  const emitted: string[] = [];
  const Host = defineComponent({
    setup() {
      return () =>
        h(TooltipProvider, null, () =>
          h(Inspector, {
            selected: null,
            part: null,
            geom: null,
            partBreak: null,
            history: [],
            partLabels: new Map([['a', 'ページ1・パーツ2']]),
            paneTab: 'props',
            commentCount: 0,
            editMode: false,
            canUp: false,
            canDown: false,
            historyGroups: groups,
            selectedNo: null,
            selectedName: '',
            'onSelect-part': (k: string) => emitted.push(k),
            ...over,
          }),
        );
    },
  });
  return { wrapper: mount(Host), emitted };
}

describe('Inspector の修正履歴の見出し', () => {
  it('未選択でも全パーツの履歴を見出しごとに出す', () => {
    const { wrapper } = mountInspector();
    const t = wrapper.text();
    expect(t).toContain('修正履歴（全パーツ）');
    expect(t).toContain('パーツを選ぶと、そのパーツの設定と履歴だけを出します');
    expect(t).toContain('概況');
    expect(t).toContain('変更1');
    expect(t).toContain('旧表（削除）');
    expect(t).toContain('このパーツの修正履歴はありません');
    expect(t).toContain('変更3');
  });

  it('見出しを押すと select-part を emit する', async () => {
    const { wrapper, emitted } = mountInspector();
    await wrapper.find('[data-history-heading="a"]').trigger('click');
    expect(emitted).toEqual(['a']);
  });

  it('選択中は番号と名前の枠を出す', () => {
    const { wrapper } = mountInspector({
      selected: { id: 'c1', name: 'div', isJinja: false },
      geom: DEFAULT_GEOM,
      selectedNo: 3,
      selectedName: '概況',
      selectedKey: 'a',
    });
    const frame = wrapper.find('[data-selected-part]');
    expect(wrapper.text()).toContain('選択中のパーツ');
    expect(frame.text()).toContain('3');
    expect(frame.text()).toContain('概況');
    expect(frame.attributes('title')).toBe('ページ1・パーツ2');
  });
});
