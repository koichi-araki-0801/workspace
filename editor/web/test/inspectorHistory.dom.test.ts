import { mount } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { DEFAULT_GEOM } from '@/features/editor/geom';
import type { HistoryGroup, RejectedReason } from '@/features/editor/historyGroups';
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
  { key: 'd', no: 3, name: '空', removed: false, offCanvas: false, entries: [], rejected: null },
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

  it('aria-disabled の見出し(削除・紙面外)を押しても select-part を出さず、履歴なしの文言も出さない', async () => {
    const gs: HistoryGroup[] = [
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
        key: 'x',
        no: null,
        name: '削除済みパーツ',
        removed: false,
        offCanvas: true,
        entries: [entry('9', 'x')],
        rejected: null,
      },
    ];
    const { wrapper, emitted } = mountInspector({ historyGroups: gs });
    const b = wrapper.find('[data-history-heading="b"]');
    expect(b.attributes('aria-disabled')).toBe('true');
    // 選べない理由は読み上げの文字として中身の後ろに足す(aria-label で中身を上書きしない)。
    expect(b.attributes('aria-label')).toBeUndefined();
    expect(b.text()).toBe('2変更 2旧表（削除）。削除したパーツのため選べません');
    expect(b.find('.sr-only').exists()).toBe(true);
    await b.trigger('click');
    await wrapper.find('[data-history-heading="x"]').trigger('click');
    expect(emitted).toEqual([]);
    expect(wrapper.text()).not.toContain('このパーツの修正履歴はありません');
  });

  it('番号の丸は読み上げから外し、役割を持つ見出しのボタンの名前に「変更 N」を文字で入れる', () => {
    const { wrapper } = mountInspector();
    const a = wrapper.find('[data-history-heading="a"]');
    // 丸は見た目だけ(役割の無い span の aria-label は支援技術に無視されうる)。
    const pill = a.find('.no-pill');
    expect(pill.attributes('aria-hidden')).toBe('true');
    expect(pill.attributes('aria-label')).toBeUndefined();
    expect(a.find('.sr-only').text()).toBe('変更 1');
    expect(a.attributes('aria-label')).toBeUndefined();
    // 選択中のパーツの枠の丸も同じ。
    const { wrapper: sel } = mountInspector({
      selected: { id: 'c1', name: 'div', isJinja: false },
      geom: DEFAULT_GEOM,
      selectedNo: 3,
      selectedName: '概況',
      selectedKey: 'a',
    });
    const frame = sel.find('[data-selected-part]');
    expect(frame.find('.no-pill').attributes('aria-hidden')).toBe('true');
    expect(frame.find('.sr-only').text()).toBe('変更 3');
  });

  it('「現在の紙面に無いパーツ」の小見出しは 1 回だけ出す', () => {
    const off = (key: string): HistoryGroup => ({
      key,
      no: null,
      name: '削除済みパーツ',
      removed: false,
      offCanvas: true,
      entries: [entry(key, key)],
      rejected: null,
    });
    const { wrapper } = mountInspector({ historyGroups: [off('x'), off('y')] });
    expect(wrapper.findAll('[data-off-canvas-heading]')).toHaveLength(1);
  });

  it('未選択でグループが 0 件なら既存の空表示を出す', () => {
    const { wrapper } = mountInspector({ historyGroups: [] });
    expect(wrapper.text()).toContain('変更履歴はまだありません。');
  });

  it('6 件以上は 5 件と「さらに 1 件を表示」を出し、押すと全件を出す', async () => {
    const many: HistoryGroup[] = [
      {
        key: 'a',
        no: 1,
        name: '概況',
        removed: false,
        offCanvas: false,
        entries: Array.from({ length: 6 }, (_, i) => entry(String(i + 1), 'a')),
        rejected: null,
      },
    ];
    const { wrapper } = mountInspector({ historyGroups: many });
    expect(wrapper.text()).toContain('変更5');
    expect(wrapper.text()).not.toContain('変更6');
    const more = wrapper.find('[data-history-more]');
    expect(more.text()).toBe('さらに 1 件を表示');
    await more.trigger('click');
    expect(wrapper.text()).toContain('変更6');
    expect(wrapper.find('[data-history-more]').exists()).toBe(false);
  });
});

describe('Inspector の却下の理由', () => {
  const reason: RejectedReason = {
    partKey: 'a',
    reason: '数値が<b>違う</b>\n2 行目',
    decidedBy: '承認 太郎',
    decidedAt: '2026-10-28T01:02:00.000Z',
    name: null,
  };

  it('選択中のパーツの見出しのすぐ下に、判定者と日時の見出しと理由をエスケープして出す', () => {
    const { wrapper } = mountInspector({
      selected: { id: 'c1', name: 'div', isJinja: false },
      geom: DEFAULT_GEOM,
      selectedNo: 1,
      selectedName: '概況',
      selectedKey: 'a',
      selectedRejected: reason,
    });
    const box = wrapper.find('[data-rejected-reason]');
    expect(box.text()).toContain('却下の理由（承認 太郎・');
    expect(box.find('.rejected-body').text()).toBe('数値が<b>違う</b>\n2 行目');
    expect(box.find('b').exists()).toBe(false);
    // 選択中のパーツの枠の直後に置く。
    expect(wrapper.find('[data-selected-part] + [data-rejected-reason]').exists()).toBe(true);
  });

  it('選択中でも理由が無ければ枠を出さない', () => {
    const { wrapper } = mountInspector({
      selected: { id: 'c1', name: 'div', isJinja: false },
      geom: DEFAULT_GEOM,
      selectedKey: 'a',
      selectedRejected: null,
    });
    expect(wrapper.find('[data-rejected-reason]').exists()).toBe(false);
  });

  it('未選択の修正履歴は見出しの下に枠を出し、紙面に無い却下は末尾の小見出しの下に並べる', () => {
    const off: HistoryGroup = {
      key: 'p#2',
      no: null,
      name: '申請の本文の名前',
      removed: false,
      offCanvas: true,
      entries: [],
      rejected: { ...reason, partKey: 'p#2', reason: '追加は不要', name: '申請の本文の名前' },
    };
    const { wrapper } = mountInspector({
      historyGroups: [{ ...groups[0], rejected: reason }, groups[3], off],
    });
    const a = wrapper.find('[data-history-group="a"]');
    expect(a.find('[data-rejected-reason]').text()).toContain('数値が<b>違う</b>');
    expect(wrapper.find('[data-history-group="c"] [data-rejected-reason]').exists()).toBe(false);
    const o = wrapper.find('[data-history-group="p#2"]');
    expect(o.text()).toContain('申請の本文の名前');
    expect(o.find('[data-rejected-reason]').text()).toContain('追加は不要');
    expect(o.text()).not.toContain('このパーツの修正履歴はありません');
    expect(wrapper.find('[data-off-canvas-heading]').text()).toBe('現在の紙面に無いパーツ');
  });

  it('紙面にあるパーツでも、履歴が無く却下の理由だけなら「修正履歴はありません」を並べない', () => {
    const { wrapper } = mountInspector({
      historyGroups: [{ ...groups[2], rejected: { ...reason, partKey: 'd' } }],
    });
    const d = wrapper.find('[data-history-group="d"]');
    expect(d.find('[data-rejected-reason]').exists()).toBe(true);
    expect(d.text()).not.toContain('このパーツの修正履歴はありません');
  });
});
