// =============================================================================
// reviewCompareDocs.test.ts — 精査画面の左右組版比較に渡す完全文書の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
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
      beforeHtml: '<div class="page">page1</div><div class="page">page2</div>',
      afterHtml: '<div class="page">page1</div><div class="page">page2-changed</div>',
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
      beforeHtml: '<div class="page">page1</div><div class="page">page2</div>',
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
      beforeHtml: '<div class="page">page1</div><div class="page">page2</div>',
      afterHtml: '<div class="page">page1</div><div class="page">page2-changed</div>',
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

  it('.page が無い文書はマーカー無し・anchors 空にdegrade', () => {
    const { beforeDoc, afterDoc, anchors } = buildCompareDocs({
      beforeHtml: '<div>no page</div>',
      afterHtml: '<div>no page</div>',
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

  it('pageAnchors は全ページ分(index=ページ index)で、anchors は変更ページのみに留まる', () => {
    const { pageAnchors, anchors } = buildCompareDocs({
      beforeHtml:
        '<div class="page">page1</div><div class="page">page2</div><div class="page">page3</div>',
      afterHtml:
        '<div class="page">page1</div><div class="page">page2-changed</div><div class="page">page3</div>',
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
      beforeHtml: '<div class="page">page1</div><div class="page">page2</div>',
      afterHtml: '<div class="page">page1</div><div class="page">page2-changed</div>',
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
      beforeHtml: '<div class="page">page1</div><div class="page">page2</div>',
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
});
