import type { Editor } from 'grapesjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { usePageGuides } from '@/features/editor/usePageGuides';
import { type PageSplit, pageItems, splitPages } from '@/lib/pageBreaks';

// =============================================================================
// usePageGuides.dom.test.ts — ページ線を区切りで分けたページの境目に 1 本ずつ引く
// =============================================================================
// jsdom はレイアウトしないので、`Canvas.getElementPos` を要素ごとの位置表で差し替える。ページの
// 分け方は本番(`useGrapes.ts` の `recomputePages`)と同じ `splitPages(pageItems(...))` で作る。

interface Pos {
  top: number;
  left: number;
  width: number;
  height: number;
}

const BODY: Pos = { top: 0, left: 10, width: 500, height: 1000 };

/**
 * 根の直下に `html` を置き、各要素を上から積んだ位置(既定の高さ 100)を返す偽の editor を作る。
 * `split` を渡すと、`splitPages` では作れないページの分け方をそのまま与える。
 */
function setup(
  html: string,
  heights: Record<string, number> = {},
  split?: (els: HTMLElement[]) => PageSplit<HTMLElement>,
) {
  const body = document.createElement('body');
  const root = document.createElement('div');
  root.innerHTML = html;
  body.appendChild(root);
  const pos = new Map<Element, Pos>([[body, BODY]]);
  let y = 0;
  for (const el of Array.from(root.children)) {
    const h = heights[el.id] ?? 100;
    pos.set(el, { top: y, left: 10, width: 500, height: h });
    y += h;
  }
  const getElementPos = vi.fn((el: Element, _opts?: { noScroll?: boolean }) => {
    const p = pos.get(el);
    if (!p) throw new Error(`no pos for ${el.id}`);
    return p;
  });
  const editor = shallowRef({
    Canvas: { getBody: () => body, getElementPos },
  } as unknown as Editor);
  const els = Array.from(root.children) as HTMLElement[];
  const pages = split ? split(els) : splitPages(pageItems(els));
  const g = usePageGuides({
    editor,
    pageBlocks: shallowRef(pages.pages),
    breakEls: shallowRef(pages.breakEls),
    breakPages: shallowRef(pages.breakPages),
  });
  return {
    g,
    getElementPos,
    split: pages,
    top: (id: string) => {
      const el = root.querySelector(`#${id}`);
      const p = el && pos.get(el);
      if (!p) throw new Error(`no pos for ${id}`);
      return p.top;
    },
  };
}

const BR = (id: string) => `<div class="pagebreak" id="${id}"></div>`;

afterEach(() => vi.restoreAllMocks());

describe('usePageGuides', () => {
  it('3 ページなら線は 2 本で、2・3 ページ目の先頭のパーツの上端に引く(inline の改ページ)', () => {
    const { g, getElementPos, top } = setup(
      '<p id="a">1</p><p id="b" style="break-before: page">2</p><p id="b2">2b</p>' +
        '<p id="c" style="break-before: page">3</p>',
    );
    g.refreshPageGuides();
    expect(g.pageGuides.value).toEqual([
      { top: top('b'), left: 10, width: 500, page: 1 },
      { top: top('c'), left: 10, width: 500, page: 2 },
    ]);
    // overlay は viewport 相対の座標で置くので、すべての測位が noScroll。
    expect(getElementPos).toHaveBeenCalled();
    for (const call of getElementPos.mock.calls) expect(call[1]).toEqual({ noScroll: true });
  });

  it('区切りの帯がページの間にあれば、線は帯の上端に引く', () => {
    const { g, top } = setup(
      `<p id="a">1</p>${BR('k1')}<p id="b">2</p>${BR('k2')}<p id="c">3</p>`,
      { k1: 30, k2: 30 },
    );
    g.refreshPageGuides();
    expect(g.pageGuides.value.map((x) => [x.top, x.page])).toEqual([
      [top('k1'), 1],
      [top('k2'), 2],
    ]);
  });

  it('白紙のページ(先頭・連続の区切り)は、帯の下に次のページの線を引く。末尾の区切りは線を作らない', () => {
    const { g, split, top } = setup(
      `${BR('k0')}<p id="a">1</p>${BR('k1')}${BR('k2')}<p id="b">2</p>${BR('k3')}` +
        `<p id="c">3</p>${BR('k4')}`,
      { k0: 30, k1: 30, k2: 30, k3: 30, k4: 30 },
    );
    g.refreshPageGuides();
    // ページは [k0] [a k1] [k2] [b k3] [c k4] の 5 枚。白紙のページの帯は、前の線と後ろの線の間に来る。
    expect(g.pageGuides.value).toHaveLength(split.pages.length - 1);
    expect(g.pageGuides.value.map((x) => [x.top, x.page])).toEqual([
      [top('a'), 1],
      [top('k1'), 2],
      [top('b'), 3],
      [top('k3'), 4],
    ]);
  });

  it('inline の break-after の直後の区切りは白紙のページで、線は帯の上端と下(次のパーツ)に引く', () => {
    const { g, top } = setup(`<p id="a" style="break-after:page">1</p>${BR('k1')}<p id="b">2</p>`, {
      k1: 30,
    });
    g.refreshPageGuides();
    expect(g.pageGuides.value.map((x) => [x.top, x.page])).toEqual([
      [top('k1'), 1],
      [top('b'), 2],
    ]);
  });

  it('左右合わせで挟んだ要素の無い白紙のページは、重なる 2 本を 1 本にまとめて白紙と印を付ける', () => {
    const { g, top } = setup('<p id="a">1</p><p id="b" style="break-before:right">2</p>');
    g.refreshPageGuides();
    // ページは [a] [] [b]。白紙の 2 ページ目の前後の線は同じ位置(b の上端)に来る。
    expect(g.pageGuides.value).toEqual([
      { top: top('b'), left: 10, width: 500, page: 2, blank: true },
    ]);
  });

  it('1 ページ目が要素の無い白紙のページなら、2 ページ目の先頭の線に blank を付ける', () => {
    const { g, top } = setup('<p id="a">1</p>', {}, (els) => ({
      pages: [[], [els[0]]],
      breakEls: [],
      breakPages: [],
    }));
    g.refreshPageGuides();
    expect(g.pageGuides.value).toEqual([
      { top: top('a'), left: 10, width: 500, page: 1, blank: true },
    ]);
  });

  it('帯の直後に要素の無い白紙のページが来ても、まとめた線は帯の上端に引く', () => {
    const { g, top } = setup(
      `<p id="a">1</p>${BR('k1')}<p id="c" style="break-before:right">2</p>`,
      { k1: 30 },
    );
    g.refreshPageGuides();
    // ページは [a k1] [] [c]。飛ばした 1 本目の位置(帯 k1 の上端)を、まとめた線が受け継ぐ。
    expect(g.pageGuides.value).toEqual([
      { top: top('k1'), left: 10, width: 500, page: 2, blank: true },
    ]);
  });

  it('要素の無い白紙のページが 2 枚続いても、まとめた線は直前の要素のあるページの帯の上端に引く', () => {
    // `splitPages` は 1 つの境目で白紙のページを 1 枚までしか作らないので、分け方を直接与える。
    const { g, top } = setup(
      `<p id="a">1</p>${BR('k1')}<p id="c">2</p>`,
      { k1: 30 },
      ([a, k1, c]) => ({
        pages: [[a], [], [], [c]],
        breakEls: [k1],
        breakPages: [0],
      }),
    );
    g.refreshPageGuides();
    // ページは [a k1] [] [] [c]。3 本の線は同じ位置に来るので 1 本にまとめ、帯 k1 の上端に引く。
    expect(g.pageGuides.value).toEqual([
      { top: top('k1'), left: 10, width: 500, page: 3, blank: true },
    ]);
  });

  it('白紙のページが無い線には blank を付けない', () => {
    const { g } = setup('<p id="a">1</p><p id="b" style="break-before:page">2</p>');
    g.refreshPageGuides();
    expect(g.pageGuides.value[0]).not.toHaveProperty('blank');
  });

  it('帯が描かれていない(高さ 0)ときは次のページの先頭のパーツの上端に引く', () => {
    const { g, top } = setup(`<p id="a">1</p>${BR('k1')}<p id="b">2</p>`, { k1: 0 });
    g.refreshPageGuides();
    expect(g.pageGuides.value.map((x) => [x.top, x.page])).toEqual([[top('b'), 1]]);
  });

  it('区切りの帯と次のパーツの inline の break-before が同じ境目なら、線は帯の上端に 1 本', () => {
    const { g, top } = setup(
      `<p id="a">1</p>${BR('k1')}<p id="b" style="break-before: page">2</p>`,
      { k1: 30 },
    );
    g.refreshPageGuides();
    expect(g.pageGuides.value.map((x) => [x.top, x.page])).toEqual([[top('k1'), 1]]);
  });

  it('canvas の body が無ければ線を消す', () => {
    const g = usePageGuides({
      editor: shallowRef({ Canvas: { getBody: () => undefined } } as unknown as Editor),
      pageBlocks: shallowRef([[], []]),
      breakEls: shallowRef([]),
      breakPages: shallowRef([]),
    });
    g.pageGuides.value = [{ top: 1, left: 0, width: 1, page: 1 }];
    g.refreshPageGuides();
    expect(g.pageGuides.value).toEqual([]);
  });

  it('位置を測れない(canvas の一時的な状態)ときは線を消し、メモの目印は測り直す', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const afterGuides = vi.fn();
    const body = document.createElement('body');
    const g = usePageGuides({
      editor: shallowRef({
        Canvas: {
          getBody: () => body,
          getElementPos: () => {
            throw new Error('no frame');
          },
        },
      } as unknown as Editor),
      pageBlocks: shallowRef([[document.createElement('p')], [document.createElement('p')]]),
      breakEls: shallowRef([]),
      breakPages: shallowRef([]),
      afterGuides,
    });
    g.pageGuides.value = [{ top: 1, left: 0, width: 1, page: 1 }];
    g.refreshPageGuides();
    expect(g.pageGuides.value).toEqual([]);
    expect(afterGuides).toHaveBeenCalledOnce();
  });

  it('1 ページなら線は引かない', () => {
    const { g } = setup('<p id="a">1</p><p id="b">2</p>');
    g.refreshPageGuides();
    expect(g.pageGuides.value).toEqual([]);
  });

  it('computed style を読まない', () => {
    const spy = vi.spyOn(window, 'getComputedStyle');
    const { g } = setup(`<p id="a">1</p>${BR('k1')}<p id="b">2</p>`, { k1: 30 });
    g.refreshPageGuides();
    expect(spy).not.toHaveBeenCalled();
  });
});
