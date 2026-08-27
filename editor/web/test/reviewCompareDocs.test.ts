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
});
