import type { Editor } from 'grapesjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { usePageGuides } from '@/features/editor/usePageGuides';
import { pageItems, splitPages } from '@/lib/pageBreaks';

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

/** 根の直下に `html` を置き、各要素を上から積んだ位置(既定の高さ 100)を返す偽の editor を作る。 */
function setup(html: string, heights: Record<string, number> = {}) {
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
  const split = splitPages(pageItems(Array.from(root.children) as HTMLElement[]));
  const g = usePageGuides({
    editor,
    pageBlocks: shallowRef(split.pages),
    breakEls: shallowRef(split.breakEls),
  });
  return {
    g,
    getElementPos,
    split,
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
        '<p id="c" style="page-break-before: always">3</p>',
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

  it('連続した区切りでは最初の帯の上端に 1 本だけ引く。先頭・末尾の区切りは線を作らない', () => {
    const { g, split, top } = setup(
      `${BR('k0')}<p id="a">1</p>${BR('k1')}${BR('k2')}<p id="b">2</p>${BR('k3')}` +
        `<p id="c">3</p>${BR('k4')}`,
      { k0: 30, k1: 30, k2: 30, k3: 30, k4: 30 },
    );
    g.refreshPageGuides();
    expect(g.pageGuides.value).toHaveLength(split.pages.length - 1);
    expect(g.pageGuides.value.map((x) => [x.top, x.page])).toEqual([
      [top('k1'), 1],
      [top('k3'), 2],
    ]);
  });

  it('帯が描かれていない(高さ 0)ときは次のページの先頭のパーツの上端に引く', () => {
    const { g, top } = setup(`<p id="a">1</p>${BR('k1')}<p id="b">2</p>`, { k1: 0 });
    g.refreshPageGuides();
    expect(g.pageGuides.value.map((x) => [x.top, x.page])).toEqual([[top('b'), 1]]);
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
