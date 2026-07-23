// =============================================================================
// overlays.test.ts — `ui/overlays.ts`(Dialog / DropdownMenu / Tooltip 集約)の回帰テスト
// =============================================================================
// オーバーレイ系は `reka-ui` の Portal で document.body 直下へ描画されるため、
// wrapper ではなく body を query して検証する。各テスト後に unmount + body 掃除で
// Portal 残骸のテスト間リークを防ぐ。
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { h, nextTick } from 'vue';
import { Dialog } from '../src/components/ui/overlays';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});

describe('Dialog', () => {
  // `reka-ui` の Teleport は mount 完了(`useMounted`)後の再レンダリングで初めて body へ
  // 描画するため、mount 直後に 1 tick 待ってから query する。
  const mountDialog = async (open: boolean) => {
    const w = mount(Dialog, {
      props: { open, title: 'タイトル', description: '説明文' },
      slots: { default: () => h('p', { id: 'dlg-body' }, '本文') },
      attachTo: document.body,
    });
    await nextTick();
    return w;
  };

  it('open=false では何も描画しない', async () => {
    wrapper = await mountDialog(false);
    expect(document.body.textContent).not.toContain('タイトル');
  });

  it('open=true でタイトル/説明/slot 本文を body へ描画する', async () => {
    wrapper = await mountDialog(true);
    expect(document.body.textContent).toContain('タイトル');
    expect(document.body.textContent).toContain('説明文');
    expect(document.body.querySelector('#dlg-body')?.textContent).toBe('本文');
  });

  it('description 省略時は説明要素を出さない', async () => {
    wrapper = mount(Dialog, {
      props: { open: true, title: 'タイトルのみ' },
      attachTo: document.body,
    });
    await nextTick();
    expect(document.body.textContent).toContain('タイトルのみ');
    expect(document.body.textContent).not.toContain('説明文');
  });

  it('X close クリックで update:open(false) を emit する', async () => {
    wrapper = await mountDialog(true);
    const close = document.body.querySelector<HTMLButtonElement>('[aria-label="閉じる"]');
    expect(close).not.toBeNull();
    close?.click();
    await nextTick();
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('Esc キーで update:open(false) を emit する', async () => {
    wrapper = await mountDialog(true);
    const content = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(content).not.toBeNull();
    content?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
  });

  it('contentClass が既定クラスへマージされる', async () => {
    wrapper = mount(Dialog, {
      props: { open: true, title: 't', contentClass: 'max-w-md', size: 'sm' },
      attachTo: document.body,
    });
    await nextTick();
    const content = document.body.querySelector<HTMLElement>('[role="dialog"]');
    // tailwind-merge により size=sm の `max-w-sm` は contentClass の `max-w-md` で後勝ち上書き。
    expect(content?.className).toContain('max-w-md');
    expect(content?.className).not.toContain('max-w-sm');
  });
});
