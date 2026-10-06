// Worker と同じ linkedom の DOM で判定が動くことの確認。linkedom には `Node` グローバルが無いので、
// node 環境(web-node)で回す。
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { splitPages } from '@/lib/pageBreaks';

const split = (html: string) => {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return splitPages(Array.from(document.body.children)).pages.map((p) => p.map((e) => e.id));
};

describe('splitPages(linkedom)', () => {
  it('div.pagebreak でページを分け、区切り自身はパーツにしない', () => {
    expect(
      split('<section id=a></section><div class="pagebreak"></div><section id=b></section>'),
    ).toEqual([['a'], ['b']]);
  });

  it('連続した区切りは 1 つ、先頭と末尾の区切りは無視する', () => {
    expect(
      split(
        '<div class=pagebreak></div><section id=a></section><div class=pagebreak></div>' +
          '<div class=pagebreak></div><section id=b></section><div class=pagebreak></div>',
      ),
    ).toEqual([['a'], ['b']]);
  });

  it('根の直下の inline の改ページで前に改ページ', () => {
    expect(split('<p id=a></p><p id=b style="page-break-before:always"></p>')).toEqual([
      ['a'],
      ['b'],
    ]);
  });
});
