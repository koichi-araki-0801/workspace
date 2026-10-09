// =============================================================================
// framedDiffDoc.test.ts — 差分表示の iframe 文書(比較画面・承認画面で共有)の固定
// =============================================================================
import { describe, expect, it } from 'vitest';
import { buildFramedDiffDoc } from '@/features/compare/framedDiffDoc';
import { diffHighlightCss } from '@/features/compare/htmlBlockDiff';
import { FRAME_HEIGHT_MESSAGE } from '@/lib/useIframeAutoFit';

describe('buildFramedDiffDoc', () => {
  it('断片と CSS を文書に包み、高さ通知の計測スクリプトを末尾に付ける', () => {
    const doc = buildFramedDiffDoc(18)('<p>本文</p>', '.x{color:red}');
    expect(doc).toContain('<p>本文</p>');
    expect(doc).toContain('.x{color:red}');
    expect(doc.endsWith('</script>')).toBe(true);
    expect(doc).toContain(FRAME_HEIGHT_MESSAGE);
  });

  it('padding はハイライト CSS にだけ効き、画面ごとに違う余白を出し分ける', () => {
    const wide = buildFramedDiffDoc(18)('<p>a</p>', '');
    const narrow = buildFramedDiffDoc(14)('<p>a</p>', '');
    expect(wide).toContain('18px');
    expect(narrow).toContain('14px');
    expect(diffHighlightCss(18)).toContain('18px');
  });
});
