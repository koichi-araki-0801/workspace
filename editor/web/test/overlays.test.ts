// =============================================================================
// overlays.test.ts — `ui/overlays.ts`(Dialog / DropdownMenu / Tooltip 集約)の回帰テスト
// =============================================================================
// オーバーレイ系は `reka-ui` の Portal で document.body 直下へ描画されるため、
// wrapper ではなく body を query して検証する。各テスト後に unmount + body 掃除で
// Portal 残骸のテスト間リークを防ぐ。
import { mount, type VueWrapper } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { Dialog, DropdownMenu, DropdownMenuItem, Tooltip } from '../src/components/ui/overlays';

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

describe('DropdownMenu', () => {
  // jsdom では pointerdown で開かない(reka-ui が実 PointerEvent の詳細を見る)ため、
  // キーボード操作(Enter)で開く。トリガは as-child で slot の実要素がそのまま使われる。
  const mountMenu = async (contentClass?: string, onSelect = vi.fn()) => {
    const w = mount(DropdownMenu, {
      props: { contentClass },
      slots: {
        trigger: () => h('button', { id: 'trg' }, 'menu'),
        default: () => h(DropdownMenuItem, { class: 'py-1.5', onSelect }, () => 'ITEM-1'),
      },
      attachTo: document.body,
    });
    await nextTick();
    return { w, onSelect };
  };

  const openMenu = async (w: VueWrapper) => {
    w.get('#trg').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await nextTick();
    await nextTick();
  };

  it('トリガ操作でメニューを開き、item をクラスマージ込みで描画する', async () => {
    const { w } = await mountMenu();
    wrapper = w;
    expect(document.body.textContent).not.toContain('ITEM-1');
    await openMenu(w);
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"]');
    expect(item?.textContent).toContain('ITEM-1');
    // 既定 `py-2` は呼び出し側 `py-1.5` で後勝ち上書き(tailwind-merge)。
    expect(item?.className).toContain('py-1.5');
    expect(item?.className).not.toContain('py-2 ');
  });

  it('item クリックで select を emit する', async () => {
    const { w, onSelect } = await mountMenu();
    wrapper = w;
    await openMenu(w);
    document.body
      .querySelector<HTMLElement>('[role="menuitem"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('contentClass がコンテンツ枠へマージされ、トリガは slot の実要素になる', async () => {
    const { w } = await mountMenu('max-h-72 overflow-y-auto');
    wrapper = w;
    await openMenu(w);
    const content = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(content?.className).toContain('max-h-72');
    // as-child: reka-ui のトリガ属性が slot の button 要素自身へ付与される。
    expect(w.get('#trg').attributes('aria-haspopup')).toBe('menu');
  });
});

describe('Tooltip', () => {
  // `TooltipRoot` は Provider 祖先が無いと throw するため、App.vue と同様に Provider で
  // 包んだホストを mount する。キーボードフォーカスは delay 無しの即時表示なので、
  // jsdom では focus イベントで開く。
  const mountTooltip = async (props: Record<string, unknown> = {}) => {
    const Host = defineComponent({
      setup() {
        return () =>
          h(TooltipProvider, null, () =>
            h(Tooltip, { text: 'ヒント', ...props }, () => h('button', { id: 'trg' }, 'op')),
          );
      },
    });
    const w = mount(Host, { attachTo: document.body });
    await nextTick();
    return w;
  };

  it('トリガの focus で text を body へ描画する', async () => {
    wrapper = await mountTooltip();
    expect(document.body.textContent).not.toContain('ヒント');
    wrapper.get('#trg').element.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
    await nextTick();
    await nextTick();
    expect(document.body.textContent).toContain('ヒント');
  });

  it('disabled はラップせず slot をそのまま描画する', async () => {
    wrapper = await mountTooltip({ disabled: true });
    const trg = wrapper.get('#trg');
    // reka-ui のトリガ属性(data-state 等)が付かない = 素通し。
    expect(trg.attributes('data-state')).toBeUndefined();
    trg.element.dispatchEvent(new FocusEvent('focus'));
    await nextTick();
    expect(document.body.textContent).not.toContain('ヒント');
  });
});
