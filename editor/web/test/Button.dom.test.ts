// =============================================================================
// Button.test.ts — 共通 Button の variant/size と class マージの回帰テスト
// =============================================================================
// フィーチャ層は「Button + class 上書き」で独自見た目を再現しているため、
// tailwind-merge による後勝ち上書き(基底クラスの除去)が壊れると全画面に波及する。
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Button from '../src/components/ui/Button.vue';

describe('Button', () => {
  it('既定は type=button の default variant/size で描画する', () => {
    const wrapper = mount(Button, { slots: { default: () => '保存' } });
    const button = wrapper.get('button');
    expect(button.attributes('type')).toBe('button');
    expect(button.classes()).toContain('bg-primary');
    expect(button.classes()).toContain('h-9');
    expect(button.text()).toBe('保存');
  });

  it('variant/size 指定がクラスへ反映される (ghost + iconSm)', () => {
    const wrapper = mount(Button, { props: { variant: 'ghost', size: 'iconSm' } });
    const button = wrapper.get('button');
    expect(button.classes()).toContain('hover:bg-accent');
    expect(button.classes()).toContain('h-7');
    expect(button.classes()).toContain('w-7');
    expect(button.classes()).not.toContain('bg-primary');
  });

  it('class prop が基底クラスを後勝ちで上書きする (tailwind-merge)', () => {
    const wrapper = mount(Button, {
      props: { variant: 'ghost', class: 'h-auto rounded px-3 py-1 [&_svg]:size-[15px]' },
    });
    const cls = wrapper.get('button').classes();
    expect(cls).toContain('h-auto');
    expect(cls).not.toContain('h-9');
    expect(cls).toContain('rounded');
    expect(cls).not.toContain('rounded-md');
    // アイコン強制サイズの打ち消し: 基底 `[&_svg]:size-4` は除去され 15px 指定が残る。
    expect(cls).toContain('[&_svg]:size-[15px]');
    expect(cls).not.toContain('[&_svg]:size-4');
  });

  it('disabled が属性として反映される', () => {
    const wrapper = mount(Button, { props: { disabled: true } });
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
  });
});
