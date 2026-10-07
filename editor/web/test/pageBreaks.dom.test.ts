import { describe, expect, it } from 'vitest';
import { BODY_STYLE_VIEW_ATTR } from '@/lib/bodyStyleAttr';
import { b64encodeUtf8 } from '@/lib/jinjaAttrs';
import {
  cssRuleBreakSelector,
  findElementizingChips,
  findIgnoredInlineBreaks,
  findUncountedBreaks,
  ignoredInlineBreakProps,
  inlineBreak,
  isBreakValue,
  isElementizingChip,
  isPagebreakEl,
  pagebreakCssDefined,
  pageHead,
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

  // 期待値は Vivliostyle の実際の組版(e2e `page_breaks.spec.ts` と同じ形を実ブラウザで確かめたもの)。
  // 強制改ページの間に中身が無ければ白紙のページになる。末尾の要素の後ろの改ページは消える。
  it('先頭の区切りは白紙の 1 ページ目を作り、末尾の区切りはページを作らない', () => {
    expect(
      split(
        '<div class=pagebreak></div><section id=a></section><div class=pagebreak></div>' +
          '<section id=b></section><div class=pagebreak></div>',
      ),
    ).toEqual([[], ['a'], ['b']]);
  });

  it('連続した区切りは間に白紙のページを作る(区切りの数だけ)', () => {
    expect(
      split('<p id=a></p><div class=pagebreak></div><div class=pagebreak></div><p id=b></p>'),
    ).toEqual([['a'], [], ['b']]);
    expect(
      split(
        '<p id=a></p><div class=pagebreak></div><div class=pagebreak></div>' +
          '<div class=pagebreak></div><p id=b></p>',
      ),
    ).toEqual([['a'], [], [], ['b']]);
  });

  it('末尾に連続した区切りは、最後の 1 つを除いて白紙のページを作る', () => {
    expect(split('<p id=a></p><div class=pagebreak></div><div class=pagebreak></div>')).toEqual([
      ['a'],
      [],
    ]);
  });

  it.each([
    ['break-before:page'],
    ['BREAK-BEFORE: Page !important'],
    ['break-before:left'],
    ['break-before:verso'],
    ['break-before:column'],
    ['break-before:region'],
  ])('根の直下の inline %s で前に改ページ', (style) => {
    expect(split(`<p id=a></p><p id=b style="${style}"></p>`)).toEqual([['a'], ['b']]);
  });

  it.each([
    ['page-break-before:always'],
    ['page-break-before:left'],
    ['page-break-before:right'],
    ['break-before:always'],
    ['break-before:avoid-page'],
    ['break-before:auto'],
  ])('inline の %s は改ページしない(Vivliostyle は style 属性の page-break-* と always を効かせない)', (style) => {
    expect(split(`<p id=a></p><p id=b style="${style}"></p>`)).toEqual([['a', 'b']]);
  });

  it('inline の after で後ろに改ページ', () => {
    expect(split('<p id=a style="break-after:page"></p><p id=b></p><p id=c></p>')).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
  });

  it('inline の after の直後の区切りは白紙のページを作る', () => {
    expect(
      split('<p id=a style="break-after:page"></p><div class=pagebreak></div><p id=b></p>'),
    ).toEqual([['a'], [], ['b']]);
  });

  it('区切りと次のパーツの inline の before は同じ境目なので 1 回', () => {
    expect(
      split('<p id=a></p><div class=pagebreak></div><p id=b style="break-before:page"></p>'),
    ).toEqual([['a'], ['b']]);
  });

  it('パーツの inline の after と次のパーツの before は同じ境目なので 1 回', () => {
    expect(
      split('<p id=a style="break-after:page"></p><p id=b style="break-before:page"></p>'),
    ).toEqual([['a'], ['b']]);
  });

  it('先頭のパーツの before と末尾のパーツの after は空のページを作らない', () => {
    expect(
      split('<p id=a style="break-before:page"></p><p id=b style="break-after:page"></p>'),
    ).toEqual([['a', 'b']]);
  });

  // 左右の指定は、1 ページ目を右(recto)として左右が交互に来る前提で、合わないときに白紙を挟む。
  it('right / recto は次が左のページなら白紙を挟み、left / verso は挟まない', () => {
    expect(split('<p id=a></p><p id=b style="break-before:right"></p>')).toEqual([
      ['a'],
      [],
      ['b'],
    ]);
    expect(split('<p id=a></p><p id=b style="break-before:recto"></p>')).toEqual([
      ['a'],
      [],
      ['b'],
    ]);
    expect(split('<p id=a style="break-after:right"></p><p id=b></p>')).toEqual([['a'], [], ['b']]);
    expect(split('<p id=a></p><p id=b style="break-before:left"></p>')).toEqual([['a'], ['b']]);
    expect(
      split(
        '<p id=a></p><p id=b style="break-before:right"></p><p id=c style="break-before:right"></p>',
      ),
    ).toEqual([['a'], [], ['b'], [], ['c']]);
  });

  it('同じ境目の左右の指定は、後ろのパーツの before が勝ち、page は左右の指定に負ける', () => {
    expect(
      split('<p id=a style="break-after:right"></p><p id=b style="break-before:left"></p>'),
    ).toEqual([['a'], ['b']]);
    expect(
      split('<p id=a style="break-after:left"></p><p id=b style="break-before:right"></p>'),
    ).toEqual([['a'], [], ['b']]);
    expect(
      split('<p id=a style="break-after:right"></p><p id=b style="break-before:page"></p>'),
    ).toEqual([['a'], [], ['b']]);
    expect(
      split('<p id=a></p><div class=pagebreak></div><p id=b style="break-before:right"></p>'),
    ).toEqual([['a'], [], ['b']]);
  });

  it('先頭のパーツの left は 1 ページ目を左にする(白紙を作らない)', () => {
    expect(
      split('<p id=a style="break-before:left"></p><p id=b style="break-before:left"></p>'),
    ).toEqual([['a'], [], ['b']]);
    expect(split('<div class=pagebreak></div><p id=a style="break-before:left"></p>')).toEqual([
      [],
      ['a'],
    ]);
  });

  it('page-break-* は break-* の後勝ちに加わらない(style 属性では無視される)', () => {
    expect(
      split('<p id=a></p><p id=b style="break-before:page; page-break-before:auto"></p>'),
    ).toEqual([['a'], ['b']]);
    expect(
      split('<p id=a></p><p id=b style="page-break-before:auto; break-before:page"></p>'),
    ).toEqual([['a'], ['b']]);
    expect(split('<p id=a></p><p id=b style="break-before:page; break-before:auto"></p>')).toEqual([
      ['a', 'b'],
    ]);
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

  it('要素が無ければ [[]] を返す(ページ数 1)。区切りだけの文書は区切りの数だけ白紙が続く', () => {
    expect(split('')).toEqual([[]]);
    expect(split('<div class=pagebreak></div>')).toEqual([[]]);
    expect(split('<div class=pagebreak></div><div class=pagebreak></div>')).toEqual([[], []]);
  });

  it('breakEls は先頭・末尾・連続の区切りも全部返す(帯を出すため)', () => {
    const body = bodyOf(
      '<div id=k1 class=pagebreak></div><p id=a></p><div id=k2 class=pagebreak></div>' +
        '<div id=k3 class=pagebreak></div><p id=b></p><div id=k4 class=pagebreak></div>',
    );
    const { breakEls, breakPages } = splitPages(Array.from(body.children));
    expect(breakEls.map((e) => e.id)).toEqual(['k1', 'k2', 'k3', 'k4']);
    // 区切りが置かれるページ(区切りはそのページの末尾にある)。k1 は白紙の 1 ページ目、k3 は白紙の 3 ページ目。
    expect(breakPages).toEqual([0, 1, 2, 3]);
  });
});

describe('pageHead', () => {
  const head = (html: string, i: number) =>
    pageHead(splitPages(Array.from(bodyOf(html).children)), i)?.id;

  it('パーツのあるページは最初のパーツ、白紙のページはその区切り', () => {
    const html =
      '<div id=k0 class=pagebreak></div><p id=a></p><div id=k1 class=pagebreak></div>' +
      '<div id=k2 class=pagebreak></div><p id=b></p>';
    expect([0, 1, 2, 3].map((i) => head(html, i))).toEqual(['k0', 'a', 'k2', 'b']);
  });

  it('要素の無い白紙のページ(左右合わせ)は次のページの先頭、範囲外は undefined', () => {
    const html = '<p id=a></p><p id=b style="break-before:right"></p>';
    expect([0, 1, 2, 3].map((i) => head(html, i))).toEqual(['a', 'b', 'b', undefined]);
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
        '<p style="color:red;;break-before"></p><p style="page-break-before:always"></p>',
    );
    const [plain, avoid, after, broken, legacy] = Array.from(body.children);
    expect(inlineBreak(plain, 'before')).toBe(false);
    expect(inlineBreak(avoid, 'before')).toBe(false);
    expect(inlineBreak(after, 'before')).toBe(false);
    expect(inlineBreak(after, 'after')).toBe(true);
    expect(inlineBreak(broken, 'before')).toBe(false);
    expect(inlineBreak(legacy, 'before')).toBe(false);
  });

  it('isBreakValue は改ページの値だけを受ける', () => {
    for (const v of ['page', 'left', 'right', 'recto', 'verso', 'column', 'region']) {
      expect(isBreakValue(v)).toBe(true);
    }
    for (const v of ['always', 'auto', 'avoid', 'avoid-page', '', undefined]) {
      expect(isBreakValue(v)).toBe(false);
    }
  });
});

describe('findUncountedBreaks', () => {
  it('根の直下でない div.pagebreak と、入れ子の要素の inline 改ページを返す', () => {
    const body = bodyOf(
      '<section><div id=n1 class=pagebreak></div>' +
        '<div><p id=n2 style="break-after:page"></p></div>' +
        '<p id=n3 style="break-before:page"></p><p style="page-break-before:always"></p></section>',
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

  it('固めた範囲の包みの直下の区切りは根の直下と同じに扱い、さらに入れ子なら返す', () => {
    const body = bodyOf(
      '<div class=jinja-frozen-body><div class=pagebreak></div><p style="break-after:page"></p>' +
        '<section><div id=n1 class=pagebreak></div></section></div>',
    );
    expect(findUncountedBreaks(body).map((e) => e.id)).toEqual(['n1']);
  });

  it('赤入れの削除要素([data-redline])の配下は見ない', () => {
    const body = bodyOf(
      '<div data-redline="del"><div class=pagebreak></div></div>' +
        '<section><div data-redline="del"><p style="break-before:page"></p></div></section>',
    );
    expect(findUncountedBreaks(body)).toEqual([]);
  });
});

describe('findIgnoredInlineBreaks', () => {
  it('印刷で効かない inline の改ページ指定(page-break-* と break-*:always)を持つ要素を返す', () => {
    const body = bodyOf(
      '<p id=a style="page-break-before:always"></p><p id=b style="page-break-after: Left"></p>' +
        '<p id=c style="break-after:always"></p><p style="page-break-before:auto"></p>' +
        '<section><p id=n style="page-break-after:always"></p></section>' +
        '<div data-redline="del"><p style="page-break-after:always"></p></div>',
    );
    expect(findIgnoredInlineBreaks(body).map((e) => e.id)).toEqual(['a', 'b', 'c', 'n']);
  });

  it('同じ端が break-* で改ページしていれば返さない', () => {
    const body = bodyOf(
      '<p style="page-break-before:always; break-before:page"></p>' +
        '<p style="break-after:page; page-break-after:always"></p><p style="break-before:page"></p>',
    );
    expect(findIgnoredInlineBreaks(body)).toEqual([]);
  });
});

describe('ignoredInlineBreakProps', () => {
  it('その端の効かない指定のプロパティ名を、同じプロパティは最後の値で判じて返す', () => {
    const el = bodyOf(
      '<p style="page-break-before:always; break-before:always; page-break-after:auto; ' +
        'break-after:always; break-after:page"></p>',
    ).firstElementChild as Element;
    expect(ignoredInlineBreakProps(el, 'before')).toEqual(['page-break-before', 'break-before']);
    expect(ignoredInlineBreakProps(el, 'after')).toEqual([]);
    expect(
      ignoredInlineBreakProps(bodyOf('<p></p>').firstElementChild as Element, 'after'),
    ).toEqual([]);
  });
});

describe('pagebreakCssDefined', () => {
  it.each([
    ['.pagebreak{break-after:page}', true],
    ['div.pagebreak{page-break-after:always}', true],
    ['.pagebreak{page-break-after:left}', true],
    ['.pagebreak{break-after:column}', true],
    ['.pagebreak{break-before:page}', true],
    ['.pagebreak{break-after:always}', false],
    ['.pagebreak{page-break-after:page}', false],
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

  it('canvas の本文の <style> の置き場(data-body-style)も外す', () => {
    expect(items(`<span id=s ${BODY_STYLE_VIEW_ATTR}></span><p id=a></p>`)).toEqual(['a']);
  });

  it('固めた範囲の包み(div.jinja-frozen-body)は中身へ展開し、入れ子の包みも展開する', () => {
    expect(
      items(
        '<p id=a></p><div id=f class=jinja-frozen-body><p id=b></p><div id=k class=pagebreak></div>' +
          '<div id=g class=jinja-frozen-body><p id=c></p></div></div>',
      ),
    ).toEqual(['a', 'b', 'k', 'c']);
  });

  it('根の直下の文・Jinja コメント・出力のチップと rawtext のチップは数えず、script / math のチップは数える', () => {
    expect(
      items(
        '<span id=set class="jinja-chip jinja-stmt" data-jinja="eA=="></span>' +
          '<span id=cm class="jinja-chip jinja-comment" data-jinja="eA=="></span>' +
          '<span id=v class="jinja-chip jinja-var" data-jinja="eA=="></span>' +
          '<span id=raw class="jinja-chip jinja-rawtext" data-opaque="eA==" data-opaque-kind="rawtext"></span>' +
          '<span id=sc class="jinja-chip jinja-script" data-opaque="eA==" data-opaque-kind="script"></span>' +
          '<p id=a></p>',
      ),
    ).toEqual(['sc', 'a']);
  });

  it('rawtext のチップは原文が <style> 以外の要素のときだけパーツに数える', () => {
    const chip = (id: string, source: string) =>
      `<span id=${id} class="jinja-chip jinja-rawtext" data-opaque="${b64encodeUtf8(source)}" ` +
      'data-opaque-kind="rawtext"></span>';
    expect(
      items(
        chip('st', '<style>.a{color:{{ c }}}</style>') +
          chip('ST', '<STYLE media=print>.a{}</STYLE>') +
          chip('raw', '{% raw %}{{ x }}{% endraw %}') +
          chip('ta', '<textarea>{{ a }}</textarea>') +
          chip('styles', '<styles>{{ a }}</styles>') +
          '<span id=bad class="jinja-chip jinja-rawtext" data-opaque="%%" data-opaque-kind="rawtext"></span>',
      ),
    ).toEqual(['ta', 'styles']);
  });

  it('<style> はパーツにならない(区切りの間にあっても、そのページは白紙のまま)', () => {
    const body = bodyOf(
      '<p id=a></p><div class=pagebreak></div><style>.x{}</style>' +
        '<div class=pagebreak></div><p id=b></p>',
    );
    const pages = splitPages(pageItems(Array.from(body.children))).pages;
    expect(pages.map((p) => p.map((e) => e.id))).toEqual([['a'], [], ['b']]);
  });
});

// 区切り以外の改ページの指定は編集画面のページに数えないので、警告に例のセレクタを出す。
// `.pagebreak` も、前で改ページする指定と左右の指定は区切りの数え方(後ろで改ページする要素)とずれる。
describe('cssRuleBreakSelector', () => {
  it.each([
    [['h2{break-before:page}'], 'h2'],
    [['.a{color:red}\nh2.title , h3{page-break-before:always}'], 'h2.title'],
    [['@media print{section.x{break-after:right}}'], 'section.x'],
    [['@media screen{h2{break-before:page}}'], 'h2'],
    [['.pagebreak, h2{break-after:page}'], 'h2'],
    [['.x .pagebreak{break-after:page}'], '.x .pagebreak'],
    [['.pagebreak{break-before:page}'], '.pagebreak'],
    [['div.pagebreak{break-after:left}'], 'div.pagebreak'],
    [['.pagebreak{page-break-after:right}'], '.pagebreak'],
    [['.pagebreak{break-after:recto}'], '.pagebreak'],
    [['.pagebreak{break-after:page}', 'h2{break-after:verso}'], 'h2'],
  ])('%j → %s', (css, want) => expect(cssRuleBreakSelector(css)).toBe(want));

  it.each([
    [['.pagebreak{break-after:page}']],
    [['.pagebreak{page-break-after:always}']],
    [['DIV.pagebreak{break-after:column}']],
    [['h2{break-before:auto;page-break-after:avoid}']],
    [['@page{margin:10mm}@font-face{font-family:F}']],
    [['/* h2{break-before:page} */.a{content:"h2{break-before:page}"}']],
    [[]],
  ])('数えない改ページ指定が無ければ null %j', (css) => {
    expect(cssRuleBreakSelector(css)).toBeNull();
  });
});

const varChip = (src: string) =>
  `<span class="jinja-chip jinja-var" data-jinja="${b64encodeUtf8(src)}">v</span>`;
const rawChip = (src: string) =>
  `<span class="jinja-chip jinja-rawtext" data-opaque="${b64encodeUtf8(src)}" data-opaque-kind="rawtext">r</span>`;

describe('isElementizingChip / findElementizingChips', () => {
  it('根の直下の |safe の出力と、< を含む {% raw %} だけを拾う', () => {
    const root = bodyOf(
      `<p>a</p>${varChip('{{ x|safe }}')}${varChip('{{ y }}')}${varChip('{{- z | safe -}}')}` +
        `${varChip('{{ w|safestring }}')}${varChip('{% set v = y|safe %}')}` +
        `${rawChip('{% raw %}<b>x</b>{% endraw %}')}${rawChip('{% raw %}x{% endraw %}')}` +
        `${rawChip('<style>p{}</style>')}${rawChip('<textarea>x</textarea>')}`,
    );
    const found = findElementizingChips(root).map(
      (el) => el.getAttribute('data-jinja') ?? el.getAttribute('data-opaque'),
    );
    expect(found).toEqual([
      b64encodeUtf8('{{ x|safe }}'),
      b64encodeUtf8('{{- z | safe -}}'),
      b64encodeUtf8('{% raw %}<b>x</b>{% endraw %}'),
    ]);
  });

  it('入れ子のチップは数えず、固めた範囲の包みの中身は根の直下として数える', () => {
    const root = bodyOf(
      `<p>${varChip('{{ x|safe }}')}</p>` +
        `<div class="jinja-frozen-body">${varChip('{{ y|safe }}')}</div>`,
    );
    expect(findElementizingChips(root)).toHaveLength(1);
  });

  it('チップでない要素・読めない base64 は false', () => {
    const doc = bodyOf(
      '<p data-jinja="e3sgeHxzYWZlIH19">x</p>' +
        '<span class="jinja-chip jinja-var" data-jinja="%%%">v</span>',
    );
    expect(Array.from(doc.children).map((el) => isElementizingChip(el))).toEqual([false, false]);
  });
});
