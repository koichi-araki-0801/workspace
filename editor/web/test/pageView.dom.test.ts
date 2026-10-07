import { describe, expect, it } from 'vitest';
import { clampPageIndex, markPages, PV_ATTR, pageViewCss } from '@/features/editor/pageView';
import { BODY_STYLE_VIEW_ATTR } from '@/lib/bodyStyleAttr';
import { pageItems, splitPages } from '@/lib/pageBreaks';
import { REDLINE_ATTR } from '@/lib/redlineAttr';

// pageView の純粋関数(ページの印付け / 可視制御 CSS / index クランプ)を DOM 構築のみで検証する。
// 実レイアウト(getComputedStyle/getBoundingClientRect)に依存しないため jsdom で全分岐を直接叩ける。

/** HTML から根を作り、`useGrapes.ts` の `recomputePages` と同じ並びでページに分けて印を付ける。 */
function marked(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  const children = Array.from(root.children) as HTMLElement[];
  markPages(root, splitPages(pageItems(children)));
  return root;
}

/** 根の直下の要素ごとの `PV_ATTR`(`id` → 値)。 */
function marks(root: HTMLElement): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const el of Array.from(root.children)) out[el.id] = el.getAttribute(PV_ATTR);
  return out;
}

const BR = (id: string) => `<div class="pagebreak" id="${id}"></div>`;

describe('markPages', () => {
  it('区切りで分けた 3 ページの各パーツにページ番号、区切りに直前のページ番号を付ける', () => {
    const root = marked(
      `<p id="a"></p><p id="b"></p>${BR('k1')}<p id="c"></p>${BR('k2')}<p id="d"></p>`,
    );
    expect(marks(root)).toEqual({ a: '0', b: '0', k1: '0', c: '1', k2: '1', d: '2' });
  });

  it('区切りには置かれたページの番号を付ける(先頭・連続の区切りは白紙のページ、末尾は最後のページ)', () => {
    const root = marked(`${BR('k0')}<p id="a"></p>${BR('k1')}${BR('k2')}<p id="b"></p>${BR('k3')}`);
    // 1 ページ目は k0 だけの白紙、3 ページ目は k2 だけの白紙。1 ページ表示では帯だけが見える。
    expect(marks(root)).toEqual({ k0: '0', a: '1', k1: '1', k2: '2', b: '3', k3: '3' });
  });

  it('inline の改ページで分けたページも番号を振る', () => {
    const root = marked('<p id="a"></p><p id="b" style="break-before: page"></p>');
    expect(marks(root)).toEqual({ a: '0', b: '1' });
  });

  it('白紙のページの区切りの前の数えない要素は、その白紙のページで見える', () => {
    const root = marked(
      `<p id="a"></p>${BR('k1')}<del id="d" ${REDLINE_ATTR}></del>${BR('k2')}<p id="b"></p>`,
    );
    expect(marks(root)).toEqual({ a: '0', k1: '0', d: '1', k2: '1', b: '2' });
  });

  it('数えない要素は、パーツの後ろなら直前のパーツ、区切りの後ろなら次のパーツのページになる', () => {
    const root = marked(
      `<del id="d0" ${REDLINE_ATTR}></del><p id="a"></p><del id="d1" ${REDLINE_ATTR}></del>` +
        `${BR('k1')}<span id="s" ${BODY_STYLE_VIEW_ATTR}></span><del id="d2" ${REDLINE_ATTR}></del>` +
        `<p id="b"></p><style id="st"></style>`,
    );
    expect(marks(root)).toEqual({
      d0: '0',
      a: '0',
      d1: '0',
      k1: '0',
      s: '1',
      d2: '1',
      b: '1',
      st: '1',
    });
  });

  it('inline の break-after を持つパーツの後ろの数えない要素は、次のページ(比較の振り分けと同じ)', () => {
    const root = marked(
      `<p id="a" style="break-after: page"></p><del id="d" ${REDLINE_ATTR}></del><p id="b"></p>`,
    );
    expect(marks(root)).toEqual({ a: '0', d: '1', b: '1' });
  });

  it('末尾の区切りの後ろの数えない要素は最後のページ', () => {
    const root = marked(
      `<p id="a"></p>${BR('k1')}<p id="b"></p>${BR('k2')}<del id="d" ${REDLINE_ATTR}></del>`,
    );
    expect(marks(root).d).toBe('1');
  });

  it('付け直す前に古い印を消す(根の直下でない要素の印も残さない)', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p id="a"><span id="in" ${PV_ATTR}="3"></span></p>${BR('k1')}<p id="b"></p>`;
    const [a, k1, b] = Array.from(root.children) as HTMLElement[];
    markPages(root, splitPages([a, k1, b]));
    // 区切りを消したので、2 ページから 1 ページに変わる。
    k1.remove();
    markPages(root, splitPages([a, b]));
    expect(marks(root)).toEqual({ a: '0', b: '0' });
    expect(root.querySelector('#in')?.hasAttribute(PV_ATTR)).toBe(false);
  });

  it('パーツが無ければ数えない要素はすべて 0', () => {
    const root = marked(`<del id="d" ${REDLINE_ATTR}></del>`);
    expect(marks(root)).toEqual({ d: '0' });
  });
});

describe('pageViewCss', () => {
  it('1 ページ表示・複数ページなら、現在 index 以外の印の要素だけを隠す', () => {
    const css = pageViewCss(1, 3, true);
    expect(css).toContain(`[${PV_ATTR}]:not([${PV_ATTR}="1"])`);
    expect(css).toContain('display: none !important');
    // ページ内のパーツの `display`(flex など)を上書きしない。
    expect(css).not.toContain('display: block');
  });

  it('隠す規則は区切りの帯の規則(wrapper > div.pagebreak の !important)より詳細度が高い', () => {
    // 帯(`[data-gjs-type=wrapper] > div.pagebreak`)は (0,2,1)。隠す規則は (0,3,0) 以上が要る。
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-gjs-type', 'wrapper');
    wrapper.innerHTML = `<p ${PV_ATTR}="0"></p><div class="pagebreak" ${PV_ATTR}="0"></div><p ${PV_ATTR}="1"></p>`;
    document.body.appendChild(wrapper);
    const style = document.createElement('style');
    style.textContent =
      '[data-gjs-type=wrapper] > div.pagebreak { display: block !important; }\n' +
      pageViewCss(1, 2, true);
    document.head.appendChild(style);
    try {
      const [p0, band, p1] = Array.from(wrapper.children);
      expect(getComputedStyle(band).display).toBe('none');
      expect(getComputedStyle(p0).display).toBe('none');
      expect(getComputedStyle(p1).display).not.toBe('none');
    } finally {
      style.remove();
      wrapper.remove();
    }
  });

  it('1 ページ表示でもページが 1 枚以下なら空文字(常時表示)', () => {
    expect(pageViewCss(0, 1, true)).toBe('');
    expect(pageViewCss(0, 0, true)).toBe('');
  });

  it('全ページ表示(singleMode=false)は枚数に関わらず空文字', () => {
    expect(pageViewCss(2, 5, false)).toBe('');
  });
});

describe('clampPageIndex', () => {
  it('負数は 0 に丸める', () => {
    expect(clampPageIndex(-3, 5)).toBe(0);
  });

  it('範囲内はそのまま', () => {
    expect(clampPageIndex(2, 5)).toBe(2);
  });

  it('超過は count-1 に丸める', () => {
    expect(clampPageIndex(9, 5)).toBe(4);
  });

  it('count=0 は 0 を返す', () => {
    expect(clampPageIndex(3, 0)).toBe(0);
  });
});
