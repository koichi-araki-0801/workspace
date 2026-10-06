import { describe, expect, it } from 'vitest';
import {
  findUncountedBreaks,
  inlineBreak,
  isBreakValue,
  isPagebreakEl,
  pagebreakCssDefined,
  pageItems,
  splitPages,
} from '@/lib/pageBreaks';

const bodyOf = (html: string) =>
  new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;

const split = (html: string) =>
  splitPages(Array.from(bodyOf(html).children)).pages.map((p) => p.map((e) => e.id));

describe('splitPages', () => {
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

  it.each([
    ['page-break-before:always'],
    ['break-before:page'],
    ['PAGE-BREAK-BEFORE: Always !important'],
    ['break-before:left'],
    ['break-before:right'],
    ['break-before:recto'],
    ['break-before:verso'],
  ])('根の直下の inline %s で前に改ページ', (style) => {
    expect(split(`<p id=a></p><p id=b style="${style}"></p>`)).toEqual([['a'], ['b']]);
  });

  it('inline の after で後ろに改ページ', () => {
    expect(split('<p id=a style="break-after:page"></p><p id=b></p><p id=c></p>')).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
  });

  it('inline の after と区切りが重なっても 1 回', () => {
    expect(
      split('<p id=a style="page-break-after:always"></p><div class=pagebreak></div><p id=b></p>'),
    ).toEqual([['a'], ['b']]);
  });

  it('区切りと inline の before が重なっても 1 回', () => {
    expect(
      split('<p id=a></p><div class=pagebreak></div><p id=b style="break-before:page"></p>'),
    ).toEqual([['a'], ['b']]);
  });

  it('先頭のパーツの before と末尾のパーツの after は空のページを作らない', () => {
    expect(
      split('<p id=a style="break-before:page"></p><p id=b style="break-after:page"></p>'),
    ).toEqual([['a', 'b']]);
  });

  it('同じ端の宣言は後ろが勝つ(page-break-before:always; break-before:auto は改ページしない)', () => {
    expect(
      split('<p id=a></p><p id=b style="page-break-before:always; break-before:auto"></p>'),
    ).toEqual([['a', 'b']]);
    expect(
      split('<p id=a></p><p id=b style="break-before:auto; page-break-before:always"></p>'),
    ).toEqual([['a'], ['b']]);
  });

  it('inline の宣言のコメントは空白として読む', () => {
    expect(split('<p id=a></p><p id=b style="/* c */ break-before:page"></p>')).toEqual([
      ['a'],
      ['b'],
    ]);
    expect(split('<p id=a></p><p id=b style="break-before: page /* x */"></p>')).toEqual([
      ['a'],
      ['b'],
    ]);
    // 値の途中のコメントは区切りになるので `pa ge` は無効な値
    expect(split('<p id=a></p><p id=b style="break-before: pa/**/ge"></p>')).toEqual([['a', 'b']]);
    // コメントの中の `;` で宣言を割らない
    expect(
      split('<p id=a></p><p id=b style="break-before:page /* ; break-before:auto */"></p>'),
    ).toEqual([['a'], ['b']]);
  });

  it('プロパティ名として読めない宣言は後勝ちの対象にしない', () => {
    expect(
      split('<p id=a></p><p id=b style="break-before:page; /* c */ : auto; x y:auto"></p>'),
    ).toEqual([['a'], ['b']]);
  });

  it('class="x pagebreak" も区切り、span.pagebreak や div.PageBreak は区切りでない', () => {
    expect(split('<p id=a></p><div class="x pagebreak"></div><p id=b></p>')).toEqual([
      ['a'],
      ['b'],
    ]);
    expect(split('<p id=a></p><span id=s class="pagebreak"></span><p id=b></p>')).toEqual([
      ['a', 's', 'b'],
    ]);
    expect(split('<p id=a></p><div id=d class="PageBreak"></div><p id=b></p>')).toEqual([
      ['a', 'd', 'b'],
    ]);
  });

  it('パーツが無ければ [[]] を返す(ページ数 1)', () => {
    expect(split('')).toEqual([[]]);
    expect(split('<div class=pagebreak></div><div class=pagebreak></div>')).toEqual([[]]);
  });

  it('breakEls は先頭・末尾・連続の区切りも全部返す(帯を出すため)', () => {
    const body = bodyOf(
      '<div id=k1 class=pagebreak></div><p id=a></p><div id=k2 class=pagebreak></div>' +
        '<div id=k3 class=pagebreak></div><p id=b></p><div id=k4 class=pagebreak></div>',
    );
    const { breakEls } = splitPages(Array.from(body.children));
    expect(breakEls.map((e) => e.id)).toEqual(['k1', 'k2', 'k3', 'k4']);
  });
});

describe('isPagebreakEl / inlineBreak / isBreakValue', () => {
  it('isPagebreakEl は div かつ pagebreak クラス', () => {
    const body = bodyOf('<div class=pagebreak></div><div class=page></div>');
    expect(Array.from(body.children).map(isPagebreakEl)).toEqual([true, false]);
  });

  it('inlineBreak は style が無い・値が無効・別の端なら false', () => {
    const body = bodyOf(
      '<p></p><p style="break-before:avoid"></p><p style="break-after:page"></p>' +
        '<p style="color:red;;break-before"></p>',
    );
    const [plain, avoid, after, broken] = Array.from(body.children);
    expect(inlineBreak(plain, 'before')).toBe(false);
    expect(inlineBreak(avoid, 'before')).toBe(false);
    expect(inlineBreak(after, 'before')).toBe(false);
    expect(inlineBreak(after, 'after')).toBe(true);
    expect(inlineBreak(broken, 'before')).toBe(false);
  });

  it('isBreakValue は改ページの値だけを受ける', () => {
    for (const v of ['always', 'page', 'left', 'right', 'recto', 'verso']) {
      expect(isBreakValue(v)).toBe(true);
    }
    for (const v of ['auto', 'avoid', '', undefined]) expect(isBreakValue(v)).toBe(false);
  });
});

describe('findUncountedBreaks', () => {
  it('根の直下でない div.pagebreak と、入れ子の要素の inline 改ページを返す', () => {
    const body = bodyOf(
      '<section><div id=n1 class=pagebreak></div>' +
        '<div><p id=n2 style="page-break-after:always"></p></div>' +
        '<p id=n3 style="break-before:page"></p></section>',
    );
    expect(findUncountedBreaks(body).map((e) => e.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('根の直下の区切りと inline は返さない', () => {
    const body = bodyOf(
      '<p style="break-before:page"></p><div class=pagebreak></div>' +
        '<p style="break-after:page"><span></span></p>',
    );
    expect(findUncountedBreaks(body)).toEqual([]);
  });

  it('赤入れの削除要素([data-redline])の配下は見ない', () => {
    const body = bodyOf(
      '<div data-redline="del"><div class=pagebreak></div></div>' +
        '<section><div data-redline="del"><p style="break-before:page"></p></div></section>',
    );
    expect(findUncountedBreaks(body)).toEqual([]);
  });
});

describe('pagebreakCssDefined', () => {
  it.each([
    ['.pagebreak{break-after:page}', true],
    ['div.pagebreak{page-break-after:always}', true],
    ['@media print{.pagebreak{page-break-before:always}}', true],
    ['.a, .pagebreak{break-after:page}', true],
    ['.pagebreak { color: red; page-break-after: always !important; }', true],
    ['/* c */ .pagebreak{break-after:page}', true],
    ['.pagebreak{/* c */ break-after:page}', true],
    ['.pagebreak{break-after:/* c */page}', true],
    ['.pagebreak{color:red /* ; break-after:page */}', false],
    ['.pagebreak{display:none}', false],
    ['.pagebreak{break-after:avoid}', false],
    ['.page{page-break-after:always}', false],
    ['DIV.pagebreak{break-after:page}', true],
    ['.PageBreak{break-after:page}', false],
    ['.x .pagebreak{break-after:page}', false],
    ['@font-face{font-family:a}', false],
    ['', false],
  ])('%s → %s', (css, want) => expect(pagebreakCssDefined(css)).toBe(want));
});

describe('pageItems', () => {
  const items = (html: string) => pageItems(Array.from(bodyOf(html).children)).map((e) => e.id);

  it('<style> と赤入れの削除要素を外し、区切りとパーツは残す', () => {
    expect(
      items(
        '<style id=s0>.a{}</style><p id=a></p><div id=b1 class=pagebreak></div>' +
          '<style id=s1>.b{}</style><del id=r data-redline="del"></del><p id=b></p>',
      ),
    ).toEqual(['a', 'b1', 'b']);
  });

  it('<style> だけのページは作らない', () => {
    const body = bodyOf(
      '<p id=a></p><div class=pagebreak></div><style>.x{}</style>' +
        '<div class=pagebreak></div><p id=b></p>',
    );
    const pages = splitPages(pageItems(Array.from(body.children))).pages;
    expect(pages.map((p) => p.map((e) => e.id))).toEqual([['a'], ['b']]);
  });
});
