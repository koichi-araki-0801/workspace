// =============================================================================
// hostProtocol.test.ts — プレビューホストの資産 URL の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
import { PREVIEW_HOST_BASE, previewHostAssetUrl } from '../src/preview/hostProtocol.js';

describe('previewHostAssetUrl — 論理パス → プレビューホストの資産 URL', () => {
  it('/api とプレビューホストの接頭辞を付ける', () => {
    expect(previewHostAssetUrl('css/fonts/a.woff2')).toBe(
      `/api${PREVIEW_HOST_BASE}/css/fonts/a.woff2`,
    );
    expect(previewHostAssetUrl('js/x.js')).toBe('/api/preview-host/js/x.js');
  });
  it('セグメントごとに百分率符号化し、区切りの / は残す', () => {
    expect(previewHostAssetUrl('css/fonts/a b#?.woff2')).toBe(
      '/api/preview-host/css/fonts/a%20b%23%3F.woff2',
    );
    expect(previewHostAssetUrl('js/日本.js')).toBe(
      `/api/preview-host/js/${encodeURIComponent('日本')}.js`,
    );
    expect(previewHostAssetUrl('a/%2e%2e/b')).toBe('/api/preview-host/a/%252e%252e/b');
  });
  it('対の無いサロゲートは符号化できずに投げる(呼び出し側が受ける)', () => {
    expect(() => previewHostAssetUrl(`css/${String.fromCharCode(0xd800)}.woff2`)).toThrow(URIError);
  });
});
