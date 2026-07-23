// =============================================================================
// Select.test.ts — 共通 Select の options 正規化 / v-model / disabled の回帰テスト
// =============================================================================
// `options` は文字列と `{ label, value }` の混在を受け付ける(正規化は Select.vue の
// `normalized`)。コンテンツは Portal + popper 配置のため、開いた後は body を query する。
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import Select from '../src/components/ui/Select.vue';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});

const openSelect = async (w: VueWrapper) => {
  w.get('button').element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await nextTick();
  await nextTick();
};

describe('Select', () => {
  it('placeholder を未選択時に表示する', () => {
    wrapper = mount(Select, {
      props: { options: ['a'], placeholder: '選んでください' },
      attachTo: document.body,
    });
    expect(wrapper.text()).toContain('選んでください');
  });

  it('文字列と {label, value} の混在 options を正規化して描画する', async () => {
    wrapper = mount(Select, {
      props: { options: ['そのまま', { label: '表示名', value: 'v1' }] },
      attachTo: document.body,
    });
    await openSelect(wrapper);
    const items = [...document.body.querySelectorAll('[role="option"]')];
    expect(items.map((el) => el.textContent?.trim())).toEqual(['そのまま', '表示名']);
  });

  it('選択で update:modelValue が value 側を emit し、トリガに label を表示する', async () => {
    wrapper = mount(Select, {
      props: { options: [{ label: '表示名', value: 'v1' }] },
      attachTo: document.body,
    });
    await openSelect(wrapper);
    const item = document.body.querySelector<HTMLElement>('[role="option"]');
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    // reka-ui の select 処理は内部で `await nextTick()` を複数回挟むため、少し待って確定させる。
    await new Promise((resolve) => setTimeout(resolve, 10));
    await nextTick();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['v1']);
    expect(wrapper.text()).toContain('表示名');
  });

  it('disabled でトリガを無効化する', () => {
    wrapper = mount(Select, { props: { options: ['a'], disabled: true }, attachTo: document.body });
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
  });
});
