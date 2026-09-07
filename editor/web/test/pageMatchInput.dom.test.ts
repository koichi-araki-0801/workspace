// =============================================================================
// pageMatchInput.dom.test.ts — ページ対応の番号入力欄(比較結果画面)の回帰テスト
// =============================================================================
// 数百ページの版ではプルダウンから対応ページを選べない(候補が数百件になる)ため、番号を
// 直接入力する。ここで固定する契約は「確定は Enter / blur のみ」「範囲外はクランプ」
// 「無効入力は元値へ戻す」「対応なしはトグルで往復できる」の 4 つ。
import { mount } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import PageMatchInput from '../src/features/compare/PageMatchInput.vue';

/** `Tooltip` が Provider 必須のため、App.vue と同様に Provider で包んで mount する。 */
const mountInput = (initial: number | null = 11, pageCount = 340) => {
  const model = ref<number | null>(initial);
  const updates: (number | null)[] = [];
  const Host = defineComponent({
    setup() {
      return () =>
        h(TooltipProvider, null, () =>
          h(PageMatchInput, {
            modelValue: model.value,
            pageCount,
            label: '比較元',
            'onUpdate:modelValue': (v: number | null) => {
              model.value = v;
              updates.push(v);
            },
          }),
        );
    },
  });
  return { wrapper: mount(Host), model, updates };
};

describe('PageMatchInput', () => {
  it('0 起点 index を 1 起点で表示し、総ページ数を添える', () => {
    const { wrapper } = mountInput(11, 340);
    expect(wrapper.get('input').element.value).toBe('12');
    expect(wrapper.text()).toContain('340');
  });

  it('入力の blur で 0 起点 index を emit する', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const input = wrapper.get('input');
    await input.trigger('focus');
    await input.setValue('300');
    await input.trigger('blur');
    expect(updates).toEqual([299]);
  });

  it('Enter は blur して確定する(打鍵ごとには emit しない)', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const input = wrapper.get('input');
    await input.trigger('focus');
    await input.setValue('7');
    expect(updates).toEqual([]);
    await input.trigger('keydown', { key: 'Enter' });
    await input.trigger('blur');
    expect(updates).toEqual([6]);
  });

  it('範囲外の入力は端へクランプして確定する', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const input = wrapper.get('input');
    await input.trigger('focus');
    await input.setValue('9999');
    await input.trigger('blur');
    expect(updates).toEqual([339]);
    expect(input.element.value).toBe('340');
  });

  it('空・非数値の確定は元の値へ戻し、emit しない', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const input = wrapper.get('input');
    await input.trigger('focus');
    await input.setValue('abc');
    await input.trigger('blur');
    expect(updates).toEqual([]);
    expect(input.element.value).toBe('12');
  });

  it('同じページ番号の確定では emit しない(無駄な再 diff を起こさない)', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const input = wrapper.get('input');
    await input.trigger('focus');
    await input.setValue('12');
    await input.trigger('blur');
    expect(updates).toEqual([]);
  });

  it('上下キーで ±1 ページ動かす', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const input = wrapper.get('input');
    await input.trigger('keydown', { key: 'ArrowUp' });
    expect(updates).toEqual([12]);
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(updates).toEqual([12, 11]);
  });

  it('PageUp / PageDown で ±10 ページ動かす(数百ページの粗い移動)', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const input = wrapper.get('input');
    await input.trigger('keydown', { key: 'PageUp' });
    expect(updates).toEqual([21]);
    await input.trigger('keydown', { key: 'PageDown' });
    expect(updates).toEqual([21, 11]);
  });

  it('対応なしのまま上下キーを押すと先頭ページから始める', async () => {
    const { updates, wrapper } = mountInput(null, 340);
    await wrapper.get('input').trigger('keydown', { key: 'ArrowUp' });
    expect(updates).toEqual([0]);
  });

  it('ページ数 0 の側はキー操作でも値が動かない', async () => {
    const { updates, wrapper } = mountInput(null, 0);
    await wrapper.get('input').trigger('keydown', { key: 'ArrowUp' });
    expect(updates).toEqual([]);
  });

  it('割り当てのないキーは既定動作を妨げない', async () => {
    const { updates, wrapper } = mountInput(11, 340);
    await wrapper.get('input').trigger('keydown', { key: 'a' });
    expect(updates).toEqual([]);
  });

  it('「対応なし」ボタンで null にし、もう一度押すと直前のページへ戻す', async () => {
    const { wrapper, updates } = mountInput(11, 340);
    const button = wrapper.get('[data-testid="page-match-none"]');
    await button.trigger('click');
    expect(updates).toEqual([null]);
    expect(wrapper.get('input').element.value).toBe('');
    expect(button.attributes('aria-pressed')).toBe('true');
    await button.trigger('click');
    expect(updates).toEqual([null, 11]);
  });

  it('対応なしから直接ページ番号を入力して復帰できる', async () => {
    const { wrapper, updates } = mountInput(null, 340);
    const input = wrapper.get('input');
    expect(input.element.value).toBe('');
    await input.trigger('focus');
    await input.setValue('3');
    await input.trigger('blur');
    expect(updates).toEqual([2]);
  });

  it('ページ数 0 の側は入力欄を無効にし、対応なしのまま置く', () => {
    const { wrapper } = mountInput(null, 0);
    expect(wrapper.get('input').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="page-match-none"]').attributes('disabled')).toBeDefined();
  });
});
