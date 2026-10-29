import { describe, expect, it } from 'vitest';
import { partLabelMap, partPageIndexMap } from '@/features/editor/partKey';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('partPageIndexMap', () => {
  it('partLabelMap と同じキーで、区切りで分けた 0 始まりのページ index を返す', () => {
    const r = root(
      '<h1 id="cover"></h1><p></p><div class="pagebreak"></div><table></table>' +
        '<p style="break-before:page"></p><p style="page-break-before:always"></p>',
    );
    const labels = partLabelMap(r);
    const pages = partPageIndexMap(r);
    expect([...pages.keys()]).toEqual([...labels.keys()]);
    expect([...pages]).toEqual([
      ['cover#1', 0],
      ['p#1', 0],
      ['table#1', 1],
      ['p#2', 2],
      // style 属性の page-break-before は改ページしない(印刷でも効かない)。
      ['p#3', 2],
    ]);
  });

  it('白紙のページも番号に数える(先頭・連続の区切り)', () => {
    const r = root(
      '<div class="pagebreak"></div><h1></h1><div class="pagebreak"></div>' +
        '<div class="pagebreak"></div><p></p>',
    );
    expect([...partPageIndexMap(r)]).toEqual([
      ['h1#1', 1],
      ['p#1', 3],
    ]);
  });
});
