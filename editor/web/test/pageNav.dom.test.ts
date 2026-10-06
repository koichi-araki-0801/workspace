// =============================================================================
// pageNav.dom.test.ts — `PageNav.vue` の総ページ数のヒント(`countHint`)
// =============================================================================
// 編集画面のページ数は区切り単位で、紙のページ数と違いうる。編集画面だけが `countHint` を渡し、
// 総ページ数にツールチップを付ける。プレビューと比較は渡さないので、ツールチップが付かないこと
// も固定する。ツールチップは `reka-ui` の Portal で body へ描かれるので body を見る。
import { mount, type VueWrapper } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import PageNav from '@/components/PageNav.vue';

const HINT = 'ページ数は区切り単位です。紙のページ数はプレビューで確かめてください';

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});

async function mountNav(props: Record<string, unknown>): Promise<VueWrapper> {
  const Host = defineComponent({
    setup() {
      return () =>
        h(TooltipProvider, null, () => h(PageNav, { currentPage: 2, pageCount: 120, ...props }));
    },
  });
  const w = mount(Host, { attachTo: document.body });
  await nextTick();
  return w;
}

/** 総ページ数の表示(`/ N`)。 */
const countEl = (w: VueWrapper) => {
  const el = w.findAll('span').find((s) => s.text() === '/ 120');
  if (!el) throw new Error('総ページ数の表示が無い');
  return el;
};

describe('PageNav の countHint', () => {
  it('渡すと総ページ数にフォーカスでき、フォーカスでヒントを出す', async () => {
    wrapper = await mountNav({ countHint: HINT });
    const count = countEl(wrapper);
    expect(count.attributes('tabindex')).toBe('0');
    expect(document.body.textContent).not.toContain(HINT);
    count.element.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
    await nextTick();
    await nextTick();
    expect(document.body.textContent).toContain(HINT);
  });

  it('渡さなければツールチップを付けず、フォーカスの対象にもしない', async () => {
    wrapper = await mountNav({});
    const count = countEl(wrapper);
    expect(count.attributes('tabindex')).toBeUndefined();
    expect(count.attributes('data-state')).toBeUndefined();
    count.element.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
    await nextTick();
    await nextTick();
    expect(document.body.textContent).not.toContain(HINT);
  });

  it('入力欄の幅は countHint の有無で変わらない', async () => {
    wrapper = await mountNav({ countHint: HINT });
    const withHint = wrapper.get('input').attributes('style');
    wrapper.unmount();
    wrapper = await mountNav({});
    expect(wrapper.get('input').attributes('style')).toBe(withHint);
    expect(withHint).toContain('width: 4.5ch');
  });
});
