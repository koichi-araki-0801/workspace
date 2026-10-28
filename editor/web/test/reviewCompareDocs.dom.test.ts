// =============================================================================
// reviewCompareDocs.test.ts — 精査画面の左右組版比較に渡す完全文書の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
import { buildHtmlDiff, MAX_TOP_LEVEL_BLOCKS } from '@/features/compare/htmlBlockDiff';
import { buildCompareDocs } from '@/features/reviews/services/reviewCompareDocs';

const NO_MARKER_PART_KEYS = new Set<string>();

describe('buildCompareDocs', () => {
  it('完全なHTML文書(doctype + lang="ja" + CSS内蔵)を返す', () => {
    const { beforeDoc, afterDoc } = buildCompareDocs({
      beforeHtml: '<div class="page">before</div>',
      afterHtml: '<div class="page">after</div>',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
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

  it('2ページのうちindex 1だけchangedなら、指定した2ページ目のパーツとアンカーを付ける', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2-changed</div>',
      beforeMarkerPartKeys: new Set(['.page#2']),
      afterMarkerPartKeys: new Set(['.page#2']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });

    expect(afterDoc).toContain('id="review-anchor-2"');
    expect(afterDoc).toContain('data-review-marker');
    expect(anchors).toEqual(['review-anchor-2']);
  });

  it('既存idを持つパーツはidを温存し、指定したpartKeyへ印を付ける', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page" id="custom-id">page1</div>',
      afterHtml: '<div class="page" id="custom-id">page1-changed</div>',
      beforeMarkerPartKeys: new Set(['custom-id#1']),
      afterMarkerPartKeys: new Set(['custom-id#1']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });

    expect(afterDoc).toContain('id="custom-id"');
    expect(afterDoc).toContain('data-review-marker');
    expect(anchors).toEqual(['custom-id']);
  });

  it('afterに無いページindexはbeforeから拾う(削除ページ)', () => {
    const { beforeDoc, afterDoc, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div>',
      afterHtml: '<div class="page">page1</div>',
      beforeMarkerPartKeys: new Set(['.page#2']),
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });

    expect(anchors).toContain('review-anchor-2');
    expect(beforeDoc).toContain('data-review-marker');
    expect(afterDoc).not.toContain('data-review-marker');
  });

  it('marker: falseでは対象属性とアンカーを残し、見た目の装飾を付けない', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page">page1</div>',
      afterHtml: '<div class="page">page1-changed</div>',
      beforeMarkerPartKeys: new Set(['.page#1']),
      afterMarkerPartKeys: new Set(['.page#1']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: false,
    });

    const doc = new DOMParser().parseFromString(afterDoc, 'text/html');
    const marked = doc.body.querySelector('[data-review-marker]') as HTMLElement | null;

    expect(marked).not.toBeNull();
    expect(marked?.style.getPropertyValue('background-color')).toBe('');
    expect(marked?.style.getPropertyValue('outline')).toBe('');
    expect(marked?.style.getPropertyValue('outline-offset')).toBe('');
    expect(afterDoc).not.toContain('@layer');
    expect(anchors).toEqual(['review-anchor-1']);
  });

  it('marker: trueでは指定した変更要素へインライン重要宣言を付ける', () => {
    const { afterDoc } = buildCompareDocs({
      beforeHtml: '<div class="page">before</div>',
      afterHtml:
        '<div class="page" style="color: red; background-color: black; outline: none">' +
        'after' +
        '</div>',
      beforeMarkerPartKeys: new Set(['.page#1']),
      afterMarkerPartKeys: new Set(['.page#1']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });

    const doc = new DOMParser().parseFromString(afterDoc, 'text/html');
    const marked = doc.body.querySelector('[data-review-marker]') as HTMLElement | null;

    expect(marked).not.toBeNull();
    expect(marked?.style.getPropertyValue('background-color')).toMatch(
      /#fff3bf|rgb\(255,\s*243,\s*191\)/i,
    );
    expect(marked?.style.getPropertyPriority('background-color')).toBe('important');
    expect(marked?.style.getPropertyValue('outline')).toMatch(/2px.*solid/i);
    expect(marked?.style.getPropertyPriority('outline')).toBe('important');
    expect(marked?.style.getPropertyValue('outline-offset')).toBe('1px');
    expect(marked?.style.getPropertyPriority('outline-offset')).toBe('important');

    // マーカーと無関係な既存インラインスタイルは維持する。
    expect(marked?.style.getPropertyValue('color')).not.toBe('');

    // preview-hostが解釈できない`@layer`へ依存しない。
    expect(afterDoc).not.toContain('@layer');
  });

  it('changed相当のパーツは修正前・修正後の両側へ印を付ける', () => {
    const { beforeDoc, afterDoc } = buildCompareDocs({
      beforeHtml: '<section data-part-id="changed-part">変更前</section>',
      afterHtml: '<section data-part-id="changed-part">変更後</section>',
      beforeMarkerPartKeys: new Set(['changed-part#1']),
      afterMarkerPartKeys: new Set(['changed-part#1']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });

    const before = new DOMParser().parseFromString(beforeDoc, 'text/html');
    const after = new DOMParser().parseFromString(afterDoc, 'text/html');

    const beforeMarked = before.querySelector(
      '[data-part-id="changed-part"][data-review-marker]',
    ) as HTMLElement | null;
    const afterMarked = after.querySelector(
      '[data-part-id="changed-part"][data-review-marker]',
    ) as HTMLElement | null;

    expect(beforeMarked?.textContent).toBe('変更前');
    expect(afterMarked?.textContent).toBe('変更後');
    expect(beforeMarked?.style.getPropertyPriority('background-color')).toBe('important');
    expect(afterMarked?.style.getPropertyPriority('background-color')).toBe('important');
  });

  it('追加パーツは修正後側だけへ印を付ける', () => {
    const { beforeDoc, afterDoc } = buildCompareDocs({
      beforeHtml: '<section class="base">既存</section>',
      afterHtml:
        '<section class="base">既存</section>' +
        '<section data-part-id="added-part">追加</section>',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: new Set(['added-part#1']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });

    const before = new DOMParser().parseFromString(beforeDoc, 'text/html');
    const after = new DOMParser().parseFromString(afterDoc, 'text/html');

    expect(before.querySelector('[data-review-marker]')).toBeNull();

    const marked = after.querySelector(
      '[data-part-id="added-part"][data-review-marker]',
    ) as HTMLElement | null;

    expect(marked?.textContent).toBe('追加');
    expect(marked?.style.getPropertyPriority('background-color')).toBe('important');
  });

  it('削除パーツは修正前側だけへ印を付ける', () => {
    const { beforeDoc, afterDoc } = buildCompareDocs({
      beforeHtml:
        '<section class="base">既存</section>' +
        '<section data-part-id="removed-part">削除対象</section>',
      afterHtml: '<section class="base">既存</section>',
      beforeMarkerPartKeys: new Set(['removed-part#1']),
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });

    const before = new DOMParser().parseFromString(beforeDoc, 'text/html');
    const after = new DOMParser().parseFromString(afterDoc, 'text/html');

    const marked = before.querySelector(
      '[data-part-id="removed-part"][data-review-marker]',
    ) as HTMLElement | null;

    expect(marked?.textContent).toBe('削除対象');
    expect(marked?.style.getPropertyPriority('background-color')).toBe('important');
    expect(after.querySelector('[data-review-marker]')).toBeNull();
  });

  it('期待ページ数と数えたページ数が一致する場合は指定パーツをマークする', () => {
    const { afterDoc, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2-changed</div>',
      beforeMarkerPartKeys: new Set(['.page#2']),
      afterMarkerPartKeys: new Set(['.page#2']),
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

  it('期待ページ数と数えたページ数が不一致なら、その面を無印へdegradeする', () => {
    const { beforeDoc, afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page">page1+page2 collapsed</div>',
      afterHtml: '<div class="page">page1+page2-changed collapsed</div>',
      beforeMarkerPartKeys: new Set(['.page#1']),
      afterMarkerPartKeys: new Set(['.page#1']),
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

  it('期待ページ数が省略された場合は従来どおり検査せず、指定パーツをマークする', () => {
    const { afterDoc } = buildCompareDocs({
      beforeHtml: '<div class="page">page1</div>',
      afterHtml: '<div class="page">page1-changed</div>',
      beforeMarkerPartKeys: new Set(['.page#1']),
      afterMarkerPartKeys: new Set(['.page#1']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });

    expect(afterDoc).toContain('data-review-marker');
  });

  it('本文が空の文書はマーカー無し・anchors空にdegradeする', () => {
    const { beforeDoc, afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '',
      afterHtml: '  ',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
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

  describe('ページはパーツ単位(div.pagebreak区切り)', () => {
    const pb = '<div class="pagebreak"></div>';
    const html3 =
      `<section>a1</section><p>a2</p>${pb}<section>b1</section><p>b2</p>${pb}` +
      '<section>c1</section>';

    const opts = {
      beforeHtml: html3,
      afterHtml: html3,
      beforeMarkerPartKeys: new Set(['section#2']),
      afterMarkerPartKeys: new Set(['section#2']),
      cssBefore: '',
      cssAfter: '',
      marker: true,
    };

    const bodyOf = (doc: string) => new DOMParser().parseFromString(doc, 'text/html').body;

    it('指定したpartKeyだけに印が付き、同じページの他パーツと区切りには付かない', () => {
      const { afterDoc } = buildCompareDocs({
        ...opts,
        changedPageIndexes: new Set([1]),
      });

      const kids = Array.from(bodyOf(afterDoc).children);

      expect(kids.map((element) => element.hasAttribute('data-review-marker'))).toEqual([
        false,
        false,
        false,
        true,
        false,
        false,
        false,
      ]);

      expect(kids[2]?.className).toBe('pagebreak');
      expect(kids[5]?.className).toBe('pagebreak');
    });

    it('インラインのマーカー装飾は指定したpartKeyだけに付く', () => {
      const { afterDoc } = buildCompareDocs({
        ...opts,
        changedPageIndexes: new Set([1]),
      });

      const kids = Array.from(bodyOf(afterDoc).children) as HTMLElement[];

      for (const [index, element] of kids.entries()) {
        const isMarkedPart = index === 3;

        expect(element.style.getPropertyPriority('background-color')).toBe(
          isMarkedPart ? 'important' : '',
        );
        expect(element.style.getPropertyPriority('outline')).toBe(isMarkedPart ? 'important' : '');
        expect(element.style.getPropertyPriority('outline-offset')).toBe(
          isMarkedPart ? 'important' : '',
        );
      }

      expect(kids[2]?.className).toBe('pagebreak');
      expect(kids[2]?.style.getPropertyValue('outline')).toBe('');
      expect(kids[5]?.className).toBe('pagebreak');
      expect(kids[5]?.style.getPropertyValue('outline')).toBe('');
    });

    it('pageAnchorsは各ページの先頭パーツのidで、既存idは上書きしない', () => {
      const html =
        `<section id="mine">a1</section>${pb}<section>b1</section>${pb}` + '<section>c1</section>';

      const { pageAnchors, anchors, afterDoc } = buildCompareDocs({
        ...opts,
        beforeHtml: html,
        afterHtml: html,
        beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
        afterMarkerPartKeys: NO_MARKER_PART_KEYS,
        changedPageIndexes: new Set([1]),
      });

      expect(pageAnchors).toEqual(['mine', 'review-anchor-2', 'review-anchor-3']);
      expect(anchors).toEqual(['review-anchor-2']);
      expect(bodyOf(afterDoc).querySelector('#review-anchor-2')?.textContent).toBe('b1');
    });

    it('白紙ページはページに数え、区切りへアンカーを付けるが印は付けない', () => {
      const html =
        `<section>a1</section>${pb}` +
        '<div class="pagebreak" id="k2"></div>' +
        '<section>c1</section>';

      const { pageAnchors, anchors, afterDoc } = buildCompareDocs({
        ...opts,
        beforeHtml: html,
        afterHtml: html,
        beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
        afterMarkerPartKeys: NO_MARKER_PART_KEYS,
        changedPageIndexes: new Set([1]),
        beforeExpectedPageCount: 3,
        afterExpectedPageCount: 3,
      });

      expect(pageAnchors).toEqual(['review-anchor-1', 'k2', 'review-anchor-3']);
      expect(anchors).toEqual(['k2']);
      expect(bodyOf(afterDoc).querySelector('[data-review-marker]')).toBeNull();
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

    it('bodyの要素の並びは入力と同じで、包む要素を作らない', () => {
      const { afterDoc } = buildCompareDocs({
        ...opts,
        changedPageIndexes: new Set([0, 1, 2]),
      });

      const tags = Array.from(bodyOf(afterDoc).children).map(
        (element) => `${element.tagName.toLowerCase()}.${element.className}`,
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

  it('要素の無い本文は1ページで、そのページのアンカーは空文字になる', () => {
    const { afterDoc, anchors, pageAnchors } = buildCompareDocs({
      beforeHtml: 'text only',
      afterHtml: 'text only changed',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([0]),
      marker: true,
    });

    expect(pageAnchors).toEqual(['']);
    expect(anchors).toEqual([]);
    expect(afterDoc).not.toContain('data-review-marker');
  });

  it('文書に無いページindexの変更は印もアンカーも付けない', () => {
    const html = '<p>a</p><div class="pagebreak"></div><p>b</p>';

    const { afterDoc, anchors, pageAnchors } = buildCompareDocs({
      beforeHtml: html,
      afterHtml: html,
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([5]),
      marker: true,
    });

    expect(anchors).toEqual([]);
    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2']);
    expect(afterDoc).not.toContain('data-review-marker');
  });

  it('pageAnchorsは全ページ分で、anchorsは変更ページだけに留まる', () => {
    const { pageAnchors, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div><div class="pagebreak"></div>' +
        '<div class="page">page3</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2-changed</div><div class="pagebreak"></div>' +
        '<div class="page">page3</div>',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });

    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2', 'review-anchor-3']);
    expect(anchors).toEqual(['review-anchor-2']);
  });

  it('変更のないページもpageAnchorsからidを取得できる', () => {
    const { pageAnchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2-changed</div>',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
    });

    expect(pageAnchors[0]).toBe('review-anchor-1');
  });

  it('両面とも期待ページ数不一致ならanchors・pageAnchorsとも空になる', () => {
    const { pageAnchors, anchors } = buildCompareDocs({
      beforeHtml: '<div class="page">page1+page2 collapsed</div>',
      afterHtml: '<div class="page">page1+page2-changed collapsed</div>',
      beforeMarkerPartKeys: new Set(['.page#1']),
      afterMarkerPartKeys: new Set(['.page#1']),
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

  it('afterだけ期待ページ数不一致ならpageAnchorsをbeforeから補う', () => {
    const { pageAnchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div>',
      afterHtml: '<div class="page">page1+page2 collapsed</div>',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      beforeExpectedPageCount: 2,
      afterExpectedPageCount: 2,
      marker: true,
    });

    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2']);
  });

  it('前後でページ数が違っても縮退しなければpageAnchorsを両側から補う', () => {
    const { pageAnchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div><div class="pagebreak"></div>' +
        '<div class="page">page3</div>',
      afterHtml:
        '<div class="page">page1</div><div class="pagebreak"></div>' +
        '<div class="page">page2</div>',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      beforeExpectedPageCount: 3,
      afterExpectedPageCount: 2,
      marker: true,
    });

    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2', 'review-anchor-3']);
  });

  it('申請者CSSの相対url()を文書基準へ付け替えて埋め込む', () => {
    const { beforeDoc, afterDoc } = buildCompareDocs({
      beforeHtml: '<div class="page">b</div>',
      afterHtml: '<div class="page">a</div>',
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '@font-face{src:url(fonts/a.woff2)}',
      cssAfter: '.p{background:url(../images/x.svg)}',
      changedPageIndexes: new Set(),
      marker: false,
    });

    expect(beforeDoc).toContain('../css/fonts/a.woff2');
    expect(afterDoc).toContain('../images/x.svg');
    expect(afterDoc).not.toContain('"images/x.svg"');
  });

  it('本文のstyleはパーツに数えず、指定した次のパーツだけへ印を付ける', () => {
    const html =
      '<style>.a{}</style><p class="a">1</p><div class="pagebreak"></div>' +
      '<style>.b{}</style><p class="b">2</p>';

    const { afterDoc, pageAnchors } = buildCompareDocs({
      beforeHtml: html,
      afterHtml: html,
      beforeMarkerPartKeys: new Set(['.b#1']),
      afterMarkerPartKeys: new Set(['.b#1']),
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set([1]),
      marker: true,
      afterExpectedPageCount: 2,
    });

    expect(pageAnchors).toEqual(['review-anchor-1', 'review-anchor-2']);

    const doc = new DOMParser().parseFromString(afterDoc, 'text/html');
    const marked = doc.body.querySelector(
      'p.b#review-anchor-2[data-review-marker]',
    ) as HTMLElement | null;

    expect(marked?.textContent).toBe('2');
    expect(marked?.style.getPropertyPriority('background-color')).toBe('important');
    expect(marked?.style.getPropertyPriority('outline')).toBe('important');
    expect(marked?.style.getPropertyPriority('outline-offset')).toBe('important');
    expect(doc.body.querySelector('style[data-review-marker]')).toBeNull();
  });

  it('打ち切りでページ数が食い違った面は無印になる', { timeout: 60_000 }, () => {
    const many = Array.from({ length: MAX_TOP_LEVEL_BLOCKS }, () => '<p>x</p>').join('');
    const html =
      `<!doctype html><html><body>${many}` +
      '<div class="pagebreak"></div><p>tail</p></body></html>';

    const diff = buildHtmlDiff(html, html);

    expect(diff.truncated).toBe(true);
    expect(diff.afterPageCount).toBe(1);

    const { afterDoc, anchors, pageAnchors } = buildCompareDocs({
      beforeHtml: html,
      afterHtml: html,
      beforeMarkerPartKeys: new Set(['p#1']),
      afterMarkerPartKeys: new Set(['p#1']),
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

  it('本文全体を固めたcanvasと同じページ数で、保存文書へアンカーを付ける', () => {
    const html =
      '<p class="a">A</p><div class="pagebreak"></div>' +
      '<section class="s">S</section><div class="pagebreak"></div>' +
      '<p class="a">A3</p>';

    const { pageAnchors } = buildCompareDocs({
      beforeHtml: html,
      afterHtml: html,
      beforeMarkerPartKeys: NO_MARKER_PART_KEYS,
      afterMarkerPartKeys: NO_MARKER_PART_KEYS,
      cssBefore: '',
      cssAfter: '',
      changedPageIndexes: new Set(),
      marker: true,
      afterExpectedPageCount: 3,
    });

    expect(pageAnchors).toHaveLength(3);
  });
});
