// =============================================================================
// reviewCompareDocs.test.ts — 精査画面の左右組版比較に渡す完全文書の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
import { buildCompareDocs } from '@/features/reviews/services/reviewCompareDocs';

const afterHtml = '<div class="page"><div data-part-id="note-a">A2</div><p>same</p></div>';
const beforeHtml = '<div class="page"><div data-part-id="note-a">A1</div><p>same</p></div>';

function build(marker = true) {
  return buildCompareDocs({
    beforeHtml,
    afterHtml,
    cssBefore: '.page{margin:0}',
    cssAfter: '.page{margin:0}',
    changedKeys: new Set(['note-a#1']),
    marker,
  });
}

describe('buildCompareDocs', () => {
  it('完全な HTML 文書(CSS 内蔵)を返す', () => {
    const { beforeDoc, afterDoc } = build();
    for (const doc of [beforeDoc, afterDoc]) {
      expect(doc).toContain('<!doctype html>');
      expect(doc).toContain('.page{margin:0}');
    }
  });

  it('変更ブロックにマーカー属性とアンカー id を付与する', () => {
    const { afterDoc, anchors } = build();
    expect(afterDoc).toContain('data-review-marker');
    expect(anchors).toEqual(['review-anchor-1']);
    expect(afterDoc).toContain('id="review-anchor-1"');
  });

  it('マーカー CSS はカスケードレイヤ + !important で、レイヤ名は毎回変わる', () => {
    const a = build().afterDoc;
    const b = build().afterDoc;
    expect(a).toMatch(/@layer\s+rvm[0-9a-f]+/);
    expect(a).toContain('!important');
    expect(a).not.toContain('display:');
    const layer = (d: string) => /@layer\s+(rvm[0-9a-f]+)/.exec(d)?.[1];
    expect(layer(a)).not.toBe(layer(b));
  });

  it('marker: false ではマーカー CSS を入れない(アンカー id は残す)', () => {
    const { afterDoc, anchors } = build(false);
    expect(afterDoc).not.toContain('@layer');
    expect(anchors).toEqual(['review-anchor-1']);
  });

  it('変更キーが無い側(before に無い added 等)でも壊れない', () => {
    const { beforeDoc } = buildCompareDocs({
      beforeHtml: '',
      afterHtml,
      cssBefore: '',
      cssAfter: '',
      changedKeys: new Set(['note-a#1']),
      marker: true,
    });
    expect(beforeDoc).toContain('<!doctype html>');
  });
});
