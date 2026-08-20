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
            note: '',
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
  return { wrapper, width, applies };
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
    g.patchSelectedStyle({ width: '50%', 'margin-top': '' });
    expect(calls).toEqual([]);
    expect(changed()).toBe(0);
  });

  it('差分があれば従来どおり setStyle と change 通知を行う', () => {
    const { g, calls, changed } = setup({ width: '50%' });
    g.patchSelectedStyle({ width: '70%' });
    expect(calls).toEqual([{ width: '70%' }]);
    expect(changed()).toBe(1);
  });
});
