// =============================================================================
// reviewCompareDocs.dom.test.ts — 承認タブの紙面へ渡す完全文書の組み立て
// =============================================================================
// 本文(`buildReviewPaper`)を申請者 CSS と一緒に包み、ページの先頭へアンカーを振るだけで、
// 見た目(inline style・文字の差分の色の CSS)は足さないこと(色と札はホストが描く)を固定する。
import { buildReviewPaper, numberChangedParts, type ReviewPaper } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { buildHtmlDiff } from '@/features/compare/htmlBlockDiff';
import { buildCompareDoc } from '@/features/reviews/services/reviewCompareDocs';
import { defaultHtmlParser } from '@/lib/htmlParser';
import { linkedomParser } from '@/workers/htmlWorkerImpl';

const pb = '<div class="pagebreak"></div>';

function paperOf(before: string, after: string, highlight = true): ReviewPaper {
  const diff = buildHtmlDiff(before, after);
  return buildReviewPaper({
    diff,
    parts: numberChangedParts(diff),
    decisionOf: () => 'pending',
    side: 'after',
    highlight,
    parse: defaultHtmlParser,
  });
}

const bodyOf = (doc: string) => new DOMParser().parseFromString(doc, 'text/html').body;

describe('buildCompareDoc', () => {
  it('完全な HTML 文書(doctype・lang="ja"・申請者 CSS 内蔵)を返す', () => {
    const { doc } = buildCompareDoc({
      paper: { html: '<p>a</p>', pageCount: 1 },
      css: '.p{margin:0}',
    });
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('lang="ja"');
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain('.p{margin:0}');
  });

  it('文字の差分の色の CSS は足さず、class を付けるまでにする(色はホストが描く)', () => {
    const paper = paperOf('<p class="a">古い文</p>', '<p class="a">新しい文</p>');
    const { doc } = buildCompareDoc({ paper, css: '.a{color:black}' });
    expect(bodyOf(doc).querySelector('.cmp-ins')).not.toBeNull();
    expect(doc).not.toContain('@layer');
    expect(doc).not.toMatch(/\.cmp-(ins|del)\s*\{/);
  });

  it('文書に style 属性を足さない', () => {
    const before = `<p class="a">1</p>${pb}<p class="b">2</p>`;
    const after = `<p class="a">1x</p>${pb}<p class="c">3</p>`;
    const { doc } = buildCompareDoc({ paper: paperOf(before, after), css: '' });
    const body = bodyOf(doc);
    // 番号と空き枠の属性は付くが、見た目の宣言はどこにも無い。
    expect(body.querySelector('[data-review-no]')).not.toBeNull();
    expect(body.querySelector('[data-review-ghost]')).not.toBeNull();
    expect(body.querySelector('[style]')).toBeNull();
  });

  it('全ページの先頭にアンカー id を付ける(既存 id は上書きしない)', () => {
    const html = `<section id="mine">a1</section>${pb}<section>b1</section>${pb}<section>c1</section>`;
    const { doc, pageAnchors } = buildCompareDoc({ paper: { html, pageCount: 3 }, css: '' });
    expect(pageAnchors).toEqual(['mine', 'review-anchor-2', 'review-anchor-3']);
    expect(bodyOf(doc).querySelector('#review-anchor-2')?.textContent).toBe('b1');
  });

  it('白紙のページは区切りへアンカーを付け、要素の無い本文は空文字を置く', () => {
    const blank = buildCompareDoc({
      paper: { html: `<p>a</p>${pb}<div class="pagebreak" id="k2"></div><p>c</p>`, pageCount: 3 },
      css: '',
    });
    expect(blank.pageAnchors).toEqual(['review-anchor-1', 'k2', 'review-anchor-3']);
    expect(
      buildCompareDoc({ paper: { html: 'text only', pageCount: 1 }, css: '' }).pageAnchors,
    ).toEqual(['']);
    expect(buildCompareDoc({ paper: { html: '', pageCount: 0 }, css: '' }).pageAnchors).toEqual([]);
  });

  it('申請者 CSS の相対 url() を文書基準へ付け替え、</style> で文書を抜けさせない', () => {
    const { doc } = buildCompareDoc({
      paper: { html: '<p>a</p>', pageCount: 1 },
      css: '.p{background:url(../images/x.svg)}</style><p id="evil">x</p><style>',
    });
    expect(doc).toContain('../images/x.svg');
    expect(bodyOf(doc).querySelector('#evil')).toBeNull();
  });
});

describe('buildReviewPaper(ブラウザの DOMParser)', () => {
  // 素の断片を `DOMParser` に渡すと、先頭の `<style>` / `<link>` / `<meta>` は head へ移る。目印を
  // 外すために断片を組み直しても、それらを落とさず、head に移った要素の目印も外すこと。
  it('目印を外して組み直すとき、先頭の style / link / meta を落とさない', () => {
    const unit =
      '<div id="u"><style>.a{color:red}</style><link rel="stylesheet" href="x.css">' +
      '<meta name="k"><p data-review-no="7" class="cmp-ins">本文</p></div>';
    const html = paperOf(`${unit}<p>旧</p>`, `${unit}<p>新</p>`, false).html;
    const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
    expect(body.querySelector('#u style')?.textContent).toBe('.a{color:red}');
    expect(body.querySelector('#u link')).not.toBeNull();
    expect(body.querySelector('#u meta')).not.toBeNull();
    expect(body.querySelector('#u [data-review-no]')).toBeNull();
    expect(body.querySelector('#u .cmp-ins')).toBeNull();
  });

  it('本文直下の style / meta に書いた目印も外す(head へ移っても見落とさない)', () => {
    // 画面の差分は worker の linkedom で取るので、本文直下の style / meta も 1 つの単位になる。
    const top = '<style data-review-no="2" class="cmp-del">.a{}</style><meta data-review-keep="">';
    const diff = buildHtmlDiff(
      `${top}<p>旧</p>`,
      `${top}<p>新</p>`,
      undefined,
      undefined,
      linkedomParser,
    );
    const html = buildReviewPaper({
      diff,
      parts: numberChangedParts(diff),
      decisionOf: () => 'pending',
      side: 'after',
      highlight: false,
      parse: defaultHtmlParser,
    }).html;
    expect(html).toContain('.a{}');
    expect(html).toContain('<meta');
    expect(html).not.toMatch(/data-review-(no="2"|keep)|cmp-del/);
  });
});
