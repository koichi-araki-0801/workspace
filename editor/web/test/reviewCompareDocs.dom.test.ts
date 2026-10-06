// =============================================================================
// reviewCompareDocs.test.ts — 精査画面の左右組版比較に渡す完全文書の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
import { buildHtmlDiff, MAX_TOP_LEVEL_BLOCKS } from '@/features/compare/htmlBlockDiff';
import { buildCompareDocs } from '@/features/reviews/services/reviewCompareDocs';

describe('buildCompareDocs', () => {
  it('完全な HTML 文書(doctype + lang="ja" + CSS 内蔵)を返す', () => {
    const { beforeDoc, afterDoc } = buildCompareDocs({
      beforeHtml: '<div class="page">before</div>',
      afterHtml: '<div class="page">after</div>',
      cssBefore: '.page{margin:0}',
      cssAfter: '.page{margin:0}',
      changedPageIndexes: new Set(),
      marker: true,
    });
    for (const doc of [beforeDoc, afterDoc]) {
      expect(doc).toContain('<!doctype html>');
      expect(doc).toContain('lang="ja"');
      expect(doc).toContain('.page{margin:0}');
      expect(doc).toContain('<meta charset="utf-8">');
    }
  });

  it('.page ×2 のうち index 1 だけ changed → 2 個目の .page にのみマーカーとアンカーが付く', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2-changed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });
    expect(afterDoc).toContain('id="review-anchor-2"');
    expect(afterDoc).toContain('data-review-marker');
    expect(anchors).toEqual(['review-anchor-2']);
  });

  it('既存 id を持つ .page は id を温存し anchors にその id を入れる', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page" id="custom-id">page1</div>',
      afterHtml: '<div class="page" id="custom-id">page1-changed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });
    expect(afterDoc).toContain('id="custom-id"');
    expect(afterDoc).toContain('data-review-marker');
    expect(anchors).toEqual(['custom-id']);
  });

  it('after に無いページ index は before から拾う（削除ページ）', () => {
    const { anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div>',
      afterHtml: '<div class="page">page1</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });
    // after は index 1 に .page が無いので before から取得
    expect(anchors).toContain('review-anchor-2');
  });

  it('marker: false ではマーカー CSS を入れない（アンカー id は残す）', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page">page1</div>',
      afterHtml: '<div class="page">page1-changed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: false,
    });
    expect(afterDoc).not.toContain('@layer');
    expect(afterDoc).not.toContain('!important');
    expect(anchors).toEqual(['review-anchor-1']);
  });

  it('マーカー CSS はカスケードレイヤ + !important で、レイヤ名は毎回変わる', () => {
    const a = buildCompareDocs({
      beforeHtml: '<div class="page">test</div>',
      afterHtml: '<div class="page">test</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    }).afterDoc;
    const b = buildCompareDocs({
      beforeHtml: '<div class="page">test</div>',
      afterHtml: '<div class="page">test</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    }).afterDoc;
    expect(a).toMatch(/@layer\s+rvm[0-9a-f]{16}/);
    expect(a).toContain('!important');
    expect(a).not.toContain('display:');
    const layer = (d: string) => /@layer\s+(rvm[0-9a-f]+)/.exec(d)?.[1];
    expect(layer(a)).not.toBe(layer(b));
  });

  it('期待ページ数と実際の .page 数が一致する場合は通常通りマークする', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2-changed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      beforeExpectedPageCount: 2,
      afterExpectedPageCount: 2,
      marker: true,
    });
    expect(afterDoc).toContain('data-review-marker');
    expect(anchors).toEqual(['review-anchor-2']);
  });

  it('期待ページ数と実際の .page 数が不一致(page-break 欠落等)ならその面を無印へdegrade', () => {
    // page-break が効かず 2 ページ分の内容が 1 個の .page に潰れたケースを想定。
    // changedPageIndexes=[0] をそのまま適用すると、本来無関係な合成 1 ページを
    // 「変更ページ」として誤ってマークしてしまうため、不一致面は無印にする。
    const { beforeDoc, afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page">page1+page2 collapsed</div>',
      afterHtml: '<div class="page">page1+page2-changed collapsed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      beforeExpectedPageCount: 2,
      afterExpectedPageCount: 2,
      marker: true,
    });
    expect(beforeDoc).not.toContain('data-review-marker');
    expect(afterDoc).not.toContain('data-review-marker');
    expect(anchors).toEqual([]);
  });

  it('期待ページ数が省略された場合は従来通り検査しない', () => {
    const { afterDoc } = buildCompareDocs({
      beforeHtml: '<div class="page">page1</div>',
      afterHtml: '<div class="page">page1-changed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });
    expect(afterDoc).toContain('data-review-marker');
  });

  it('本文が空の文書はマーカー無し・anchors 空にdegrade', () => {
    const { beforeDoc, afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '',
      afterHtml: '  ',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });
    expect(beforeDoc).toContain('<!doctype html>');
    expect(afterDoc).toContain('<!doctype html>');
    expect(beforeDoc).not.toContain('data-review-marker');
    expect(afterDoc).not.toContain('data-review-marker');
    expect(anchors).toEqual([]);
  });

  describe('ページはパーツ単位(div.pagebreak 区切り)', () => {
    const pb = '<div class="pagebreak"></div>';
    const html3 =
      `<section>a1</section><p>a2</p>${pb}<section>b1</section><p>b2</p>${pb}` +
      '<section>c1</section>';
    const opts = {
      beforeHtml: html3,
      afterHtml: html3,
      cssBefore: '',
      cssAfter: '',
      marker: true,
    };
    const bodyOf = (doc: string) => new DOMParser().parseFromString(doc, 'text/html').body;

    it('変更ページの各パーツにだけ印が付き、他ページと区切りには付かない', () => {
      const { afterDoc } = buildCompareDocs({ ...opts, changedPageIndexes: new Set([1]) });
      const kids = Array.from(bodyOf(afterDoc).children);
      expect(kids.map((e) => e.hasAttribute('data-review-marker'))).toEqual([
        false,
        false,
        false,
        true,
        true,
        false,
        false,
      ]);
      expect(kids[2]?.className).toBe('pagebreak');
      expect(kids[5]?.className).toBe('pagebreak');
    });

    it('pageAnchors は各ページの先頭のパーツの id(3 件)で、既存 id は上書きしない', () => {
      const html = `<section id="mine">a1</section>${pb}<section>b1</section>${pb}<section>c1</section>`;
      const { pageAnchors, anchors, afterDoc } = buildCompareDocs({
        ...opts,
        beforeHtml: html,
        afterHtml: html,
        changedPageIndexes: new Set([1]),
      });
      expect(pageAnchors).toEqual(['mine', 'review-anchor-2', 'review-anchor-3']);
      expect(anchors).toEqual(['review-anchor-2']);
      expect(bodyOf(afterDoc).querySelector('#review-anchor-2')?.textContent).toBe('b1');
    });

    it('期待ページ数と数えた数が違えば無印', () => {
      const { afterDoc, anchors, pageAnchors } = buildCompareDocs({
        ...opts,
        changedPageIndexes: new Set([1]),
        beforeExpectedPageCount: 2,
        afterExpectedPageCount: 2,
      });
      expect(afterDoc).not.toContain('data-review-marker');
      expect(anchors).toEqual([]);
      expect(pageAnchors).toEqual([]);
    });

    it('body の要素の並びは入力と同じ(包む要素を作らない)', () => {
      const { afterDoc } = buildCompareDocs({ ...opts, changedPageIndexes: new Set([0, 1, 2]) });
      const tags = Array.from(bodyOf(afterDoc).children).map(
        (e) => `${e.tagName.toLowerCase()}.${e.className}`,
      );
      expect(tags).toEqual([
        'section.',
        'p.',
        'div.pagebreak',
        'section.',
        'p.',
        'div.pagebreak',
        'section.',
      ]);
    });
  });

  it('pageAnchors は全ページ分(index=ページ index)で、anchors は変更ページのみに留まる', () => {
    const { pageAnchors, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div><div class="pagebreak"></div><div class="page">page3</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2-changed</div><div class="pagebreak"></div><div class="page">page3</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });
    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2', 'review-anchor-3']);
    expect(anchors).toEqual(['review-anchor-2']);
  });

  it('変更のないページ(コメント宛先)も pageAnchors から id が引ける', () => {
    const { pageAnchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2-changed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });
    expect(pageAnchors[0]).toBe('review-anchor-1');
  });

  it('両面とも期待ページ数不一致(degrade)なら anchors・pageAnchors とも空(present だが無印)', () => {
    const { pageAnchors, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page">page1+page2 collapsed</div>',
      afterHtml: '<div class="page">page1+page2-changed collapsed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      beforeExpectedPageCount: 2,
      afterExpectedPageCount: 2,
      marker: true,
    });
    expect(anchors).toEqual([]);
    expect(pageAnchors).toEqual([]);
  });

  it('after のみ期待ページ数不一致なら pageAnchors は before から補われる', () => {
    const { pageAnchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div>',
      afterHtml: '<div class="page">page1+page2 collapsed</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      beforeExpectedPageCount: 2,
      afterExpectedPageCount: 2,
      marker: true,
    });
    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2']);
  });

  it('前後でページ数が違うが縮退しない場合は pageAnchors を両側から補う', () => {
    // before: 3 ページ、after: 2 ページ、いずれも期待ページ数と一致(縮退なし)
    // → pageAnchors.length === 3、indexes 0-1 は after から、index 2 は before から
    const { pageAnchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div><div class="pagebreak"></div><div class="page">page3</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div><div class="page">page2</div>',
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      beforeExpectedPageCount: 3,
      afterExpectedPageCount: 2,
      marker: true,
    });
    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2', 'review-anchor-3']);
  });

  it('申請者 CSS の相対 url() を文書基準へ付け替えて埋め込む', () => {
    const { beforeDoc, afterDoc } = buildCompareDocs({
      beforeHtml: '<div class="page">b</div>',
      afterHtml: '<div class="page">a</div>',
      cssBefore: '@font-face{src:url(fonts/a.woff2)}',
      cssAfter: '.p{background:url(../images/x.svg)}',
      changedPageIndexes: new Set(),
      marker: false,
    });
    expect(beforeDoc).toContain('../css/fonts/a.woff2');
    expect(afterDoc).toContain('../images/x.svg');
    expect(afterDoc).not.toContain('"images/x.svg"');
  });

  it('本文の <style> はパーツに数えず、印も付けない(ページの先頭は <style> の次のパーツ)', () => {
    const html =
      '<style>.a{}</style><p class="a">1</p><div class="pagebreak"></div>' +
      '<style>.b{}</style><p class="b">2</p>';
    const { afterDoc, pageAnchors } = buildCompareDocs({
      beforeHtml: html,
      afterHtml: html,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
      afterExpectedPageCount: 2,
    });
    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2']);
    expect(afterDoc).toContain('<p class="b" id="review-anchor-2" data-review-marker="">2</p>');
    expect(afterDoc).not.toMatch(/<style[^>]*data-review-marker/);
  });

  // 直下要素の打ち切り(`truncated`)で diff 側のページ数が減った面は、数えたページ数と
  // 食い違うので無印(安全側)になる。
  it('打ち切りでページ数が食い違った面は無印', { timeout: 60_000 }, () => {
    const many = Array.from({ length: MAX_TOP_LEVEL_BLOCKS }, () => '<p>x</p>').join('');
    const html = `<!doctype html><html><body>${many}<div class="pagebreak"></div><p>tail</p></body></html>`;
    const diff = buildHtmlDiff(html, html);
    expect(diff.truncated).toBe(true);
    expect(diff.afterPageCount).toBe(1);
    const { afterDoc, anchors, pageAnchors } = buildCompareDocs({
      beforeHtml: html,
      afterHtml: html,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
      beforeExpectedPageCount: diff.beforePageCount,
      afterExpectedPageCount: diff.afterPageCount,
    });
    expect(afterDoc).not.toContain('data-review-marker=');
    expect(anchors).toEqual([]);
    expect(pageAnchors).toEqual([]);
  });

  it('本文全体を固めた canvas と同じページ数で、保存した文書のページにアンカーを付ける', () => {
    // 承認は保存・描画した文書(包み・チップ無し)を読む。canvas の 3 ページ(`partKey.dom.test.ts`)と
    // 同じ数になる。
    const html =
      '<p class="a">A</p><div class="pagebreak"></div><section class="s">S</section>' +
      '<div class="pagebreak"></div><p class="a">A3</p>';
    const { pageAnchors } = buildCompareDocs({
      beforeHtml: html,
      afterHtml: html,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set(),
      marker: true,
      afterExpectedPageCount: 3,
    });
    expect(pageAnchors).toHaveLength(3);
  });
});
