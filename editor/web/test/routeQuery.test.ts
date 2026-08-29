// =============================================================================
// routeQuery.test.ts — redirect クエリ正規化の回帰テスト
// =============================================================================
// `route.query.redirect` は `?redirect=a&redirect=b` で配列になり、そのまま
// `router.push` へ渡すと例外になる。別オリジンへ出られる形も着地先にしない。
import { describe, expect, it } from 'vitest';
import { firstQueryString, safeRedirectPath } from '@/lib/routeQuery';

describe('firstQueryString', () => {
  it('配列なら先頭を採る', () => {
    expect(firstQueryString(['/a', '/b'])).toBe('/a');
  });

  it('未指定 / null は undefined', () => {
    expect(firstQueryString(undefined)).toBeUndefined();
    expect(firstQueryString(null)).toBeUndefined();
    expect(firstQueryString([null])).toBeUndefined();
  });
});

describe('safeRedirectPath', () => {
  it('アプリ内の絶対パスだけを通す', () => {
    expect(safeRedirectPath('/edit/abc')).toBe('/edit/abc');
    expect(safeRedirectPath(['/edit/abc', '/x'])).toBe('/edit/abc');
  });

  it('別オリジンへ出られる形と相対パスは捨てる', () => {
    expect(safeRedirectPath('//example.test/x')).toBeUndefined();
    expect(safeRedirectPath('https://example.test/x')).toBeUndefined();
    expect(safeRedirectPath('edit/abc')).toBeUndefined();
    expect(safeRedirectPath('')).toBeUndefined();
  });
});
