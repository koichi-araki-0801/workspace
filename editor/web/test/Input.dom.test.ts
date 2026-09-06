// =============================================================================
// Input.test.ts — 共通 Input の v-model / attrs フォールスルー / class マージの回帰テスト
// =============================================================================
// `PageNav.vue` は inputmode・aria-label・keydown ハンドラ等を attrs フォールスルーで
// 素通しする前提のため、宣言 props の追加でフォールスルーが壊れないことを固定する。
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import Input from '../src/components/ui/Input.vue';

describe('Input', () => {
  it('v-model が双方向に同期する', async () => {
    const wrapper = mount(Input, {
      props: {
        modelValue: 'abc',
        'onUpdate:modelValue': (v: unknown) => wrapper.setProps({ modelValue: v }),
      },
    });
    const input = wrapper.get('input');
    expect((input.element as HTMLInputElement).value).toBe('abc');
    await input.setValue('xyz');
    expect(wrapper.props('modelValue')).toBe('xyz');
  });

  it('未宣言の属性とイベントが input 要素へフォールスルーする', async () => {
    const onKeydown = vi.fn();
    const wrapper = mount(Input, {
      attrs: { inputmode: 'numeric', 'aria-label': 'ページ番号', onKeydown },
    });
    const input = wrapper.get('input');
    expect(input.attributes('inputmode')).toBe('numeric');
    expect(input.attributes('aria-label')).toBe('ページ番号');
    await input.trigger('keydown', { key: 'ArrowUp' });
    expect(onKeydown).toHaveBeenCalledTimes(1);
  });

  it('class prop が基底クラスを後勝ちで上書きする (tailwind-merge)', () => {
    const wrapper = mount(Input, { props: { class: 'h-7 w-auto rounded shadow-none' } });
    const cls = wrapper.get('input').classes();
    expect(cls).toContain('h-7');
    expect(cls).not.toContain('h-9');
    expect(cls).toContain('w-auto');
    expect(cls).not.toContain('w-full');
    expect(cls).toContain('shadow-none');
    expect(cls).not.toContain('shadow-sm');
  });

  it('disabled で入力を無効化する', () => {
    const wrapper = mount(Input, { props: { disabled: true } });
    expect(wrapper.get('input').attributes('disabled')).toBeDefined();
  });
});
