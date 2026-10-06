// =============================================================================
// inspectorGeom.test.ts — 幾何編集が「無変更の確定」で編集を起こさないことの回帰テスト
// =============================================================================
// 数値入力欄は blur のたびに確定(`commit`)し、`patchSelectedStyle` は change 通知で
// autosave を起こす。値が動いていないのに確定・通知まで通すと、編集していないのに draft が
// 生成され Redo スタックまで消えるため、同値では手前で止める。
import { mount } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { DEFAULT_GEOM, type LayoutGeom } from '@/features/editor/geom';
import Inspector from '@/features/editor/Inspector.vue';
import { useGrapes } from '@/features/editor/useGrapes';

// 内部の Tooltip が Provider 必須のため、`App.vue` と同様に Provider で包んで mount する。
function mountInspector(geom: LayoutGeom) {
  const applies: Partial<LayoutGeom>[] = [];
  const Host = defineComponent({
    setup() {
      return () =>
        h(TooltipProvider, null, () =>
          h(Inspector, {
            selected: { id: 'c1', name: 'div', isJinja: false },
            part: null,
            geom,
            history: [],
            noteCount: 0,
            canNote: false,
            editMode: true,
            canUp: false,
            canDown: false,
            onApply: (p: Partial<LayoutGeom>) => applies.push(p),
          }),
        );
    },
  });
  const wrapper = mount(Host);
  // 幅の数値入力欄(最初の numeric 入力)。
  const width = wrapper.findAll('input[inputmode="numeric"]')[0];
  const inputs = wrapper.findAll('input[inputmode="numeric"]');
  return { wrapper, width, marginTop: inputs[1], applies };
}

describe('Inspector の数値確定', () => {
  it('値を変えずに blur しても apply を emit しない', async () => {
    const { width, applies } = mountInspector({ ...DEFAULT_GEOM, widthPct: 60, align: 'left' });
    await width.trigger('blur');
    expect(applies).toEqual([]);
  });

  it('値を変えて blur すると apply を emit する', async () => {
    const { width, applies } = mountInspector({ ...DEFAULT_GEOM, widthPct: 60, align: 'left' });
    await width.setValue('70');
    await width.trigger('blur');
    expect(applies).toEqual([{ widthPct: 70, align: 'left' }]);
  });

  it('非数値で blur しても元値へ戻すだけで apply を emit しない', async () => {
    const { width, applies } = mountInspector({ ...DEFAULT_GEOM, widthPct: 60, align: 'left' });
    await width.setValue('abc');
    await width.trigger('blur');
    expect(applies).toEqual([]);
    expect((width.element as HTMLInputElement).value).toBe('60');
  });

  it('空で blur すると元値へ戻し、apply を emit しない(0 を当てない)', async () => {
    const { width, applies } = mountInspector({ ...DEFAULT_GEOM, widthPct: 60, align: 'left' });
    await width.setValue('');
    await width.trigger('blur');
    expect(applies).toEqual([]);
    expect((width.element as HTMLInputElement).value).toBe('60');
  });

  it('空白だけでも元値へ戻す', async () => {
    const { width, applies } = mountInspector({ ...DEFAULT_GEOM, widthPct: 60, align: 'left' });
    await width.setValue('  ');
    await width.trigger('blur');
    expect(applies).toEqual([]);
    expect((width.element as HTMLInputElement).value).toBe('60');
  });

  it('余白の欄も空なら元値へ戻す', async () => {
    const { marginTop, applies } = mountInspector({ ...DEFAULT_GEOM, marginTop: 7 });
    await marginTop.setValue('');
    await marginTop.trigger('blur');
    expect(applies).toEqual([]);
    expect((marginTop.element as HTMLInputElement).value).toBe('7');
  });
});

describe('Inspector の改ページ', () => {
  function mountPB(opts: {
    partBreak: { before: boolean; after: boolean } | null;
    isPagebreak?: boolean;
  }) {
    const applies: Partial<LayoutGeom>[] = [];
    const breaks: { edge: 'before' | 'after'; on: boolean }[] = [];
    const Host = defineComponent({
      setup() {
        return () =>
          h(TooltipProvider, null, () =>
            h(Inspector, {
              selected: {
                id: 'c1',
                name: opts.isPagebreak ? '改ページ' : 'div',
                isJinja: false,
                isPagebreak: opts.isPagebreak,
              },
              part: null,
              geom: DEFAULT_GEOM,
              partBreak: opts.partBreak,
              history: [],
              paneTab: 'props',
              commentCount: 0,
              editMode: true,
              canUp: false,
              canDown: false,
              onApply: (p: Partial<LayoutGeom>) => applies.push(p),
              onPagebreak: (e: { edge: 'before' | 'after'; on: boolean }) => breaks.push(e),
            }),
          );
      },
    });
    return { wrapper: mount(Host), applies, breaks };
  }
  const button = (w: ReturnType<typeof mount>, text: string) => {
    const b = w.findAll('button').find((x) => x.text().includes(text));
    if (!b) throw new Error(`no button ${text}`);
    return b;
  };

  it('「前で改ページ」を押すと apply ではなく pagebreak を { edge: before, on: true } で emit する', async () => {
    const { wrapper, applies, breaks } = mountPB({ partBreak: { before: false, after: false } });
    await button(wrapper, '前で改ページ').trigger('click');
    expect(applies).toEqual([]);
    expect(breaks).toEqual([{ edge: 'before', on: true }]);
  });

  it('ON の「後で改ページ」を押すと { edge: after, on: false } で emit し、状態を ON と出す', async () => {
    const { wrapper, breaks } = mountPB({ partBreak: { before: false, after: true } });
    const b = button(wrapper, '後で改ページ');
    expect(b.text()).toContain('ON');
    await b.trigger('click');
    expect(breaks).toEqual([{ edge: 'after', on: false }]);
  });

  it('「ページ内で分割しない」は今どおり apply で keepTogether を emit する', async () => {
    const { wrapper, applies, breaks } = mountPB({ partBreak: { before: false, after: false } });
    await button(wrapper, 'ページ内で分割しない').trigger('click');
    expect(applies).toEqual([{ keepTogether: true }]);
    expect(breaks).toEqual([]);
  });

  it('区切りを置けないパーツ(partBreak が null)では前後の改ページを押せない', async () => {
    const { wrapper, breaks } = mountPB({ partBreak: null });
    const b = button(wrapper, '前で改ページ');
    expect(b.attributes('disabled')).toBeDefined();
    await b.trigger('click');
    expect(breaks).toEqual([]);
  });

  it('区切りの帯を選んでいるときは、改ページ・サイズ・余白の段を出さない', () => {
    const { wrapper } = mountPB({ partBreak: null, isPagebreak: true });
    const text = wrapper.text();
    expect(text).not.toContain('前で改ページ');
    expect(text).not.toContain('ページ内で分割しない');
    expect(text).not.toContain('サイズ・配置');
    expect(text).not.toContain('余白');
    expect(text).toContain('修正履歴');
  });
});

describe('useGrapes.patchSelectedStyle', () => {
  /** GrapesJS の Editor/Component を、style パッチの経路に必要な範囲だけ模す。 */
  function fakeEditor(style: Record<string, string>) {
    const cur = { ...style };
    const calls: Record<string, string>[] = [];
    const comp = {
      getStyle: () => ({ ...cur }),
      setStyle: (s: Record<string, string>) => {
        calls.push(s);
        for (const k of Object.keys(cur)) delete cur[k];
        Object.assign(cur, s);
      },
    };
    const ed = {
      getSelected: () => comp,
      getWrapper: () => null,
      Canvas: { getDocument: () => document, getBody: () => document.body },
    };
    return { ed, calls };
  }

  function setup(style: Record<string, string>) {
    const g = useGrapes();
    const { ed, calls } = fakeEditor(style);
    // biome-ignore lint/suspicious/noExplicitAny: GrapesJS Editor の最小模擬で足りる
    g.editor.value = ed as any;
    let changed = 0;
    g.onChange(() => {
      changed++;
    });
    return { g, calls, changed: () => changed };
  }

  it('結果が現在の style と同一なら setStyle も change 通知も走らせない', () => {
    // `''` は「該当プロパティを除去」の意味なので、元から無い property は差分にならない。
    const { g, calls, changed } = setup({ width: '50%' });
    expect(g.patchSelectedStyle({ width: '50%', 'margin-top': '' })).toBe(false);
    expect(calls).toEqual([]);
    expect(changed()).toBe(0);
  });

  it('差分があれば従来どおり setStyle と change 通知を行う', () => {
    const { g, calls, changed } = setup({ width: '50%' });
    expect(g.patchSelectedStyle({ width: '70%' })).toBe(true);
    expect(calls).toEqual([{ width: '70%' }]);
    expect(changed()).toBe(1);
  });
});
