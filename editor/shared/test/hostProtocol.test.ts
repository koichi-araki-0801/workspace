// =============================================================================
// hostProtocol.test.ts — プレビューホストの資産 URL の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  isPreviewPartNo,
  PREVIEW_HOST_BASE,
  parsePreviewMarks,
  parsePreviewPartPages,
  previewHostAssetUrl,
} from '../src/preview/hostProtocol.js';

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

describe('isPreviewPartNo', () => {
  it('isPreviewPartNo は 1〜5 桁の数字だけ', () => {
    for (const ok of ['0', '7', '12345', '00001']) expect(isPreviewPartNo(ok)).toBe(true);
    for (const ng of ['', '123456', '-1', '1.5', 'a1', ' 1', '１', 1, null, undefined]) {
      expect(isPreviewPartNo(ng)).toBe(false);
    }
  });
});

describe('parsePreviewMarks', () => {
  const base = { states: { '1': 'approved', '23': 'pending' }, selected: '1', visible: true };
  it('正しい形はそのまま返す', () => {
    expect(parsePreviewMarks(base)).toEqual(base);
    expect(parsePreviewMarks({ states: {}, selected: null, visible: false })).toEqual({
      states: {},
      selected: null,
      visible: false,
    });
  });
  it('parsePreviewMarks は番号でないキー・知らない状態を含むと null', () => {
    expect(parsePreviewMarks({ ...base, states: { x: 'approved' } })).toBeNull();
    expect(parsePreviewMarks({ ...base, states: { '1': 'held' } })).toBeNull();
    expect(parsePreviewMarks({ ...base, selected: 'x' })).toBeNull();
    expect(parsePreviewMarks({ ...base, visible: 'yes' })).toBeNull();
    expect(parsePreviewMarks({ ...base, states: [] })).toBeNull();
    expect(parsePreviewMarks(null)).toBeNull();
  });
});

describe('parsePreviewPartPages', () => {
  it('番号 → 0 以上の整数を返す', () => {
    expect(parsePreviewPartPages({ '1': 0, '2': 3 })).toEqual({ '1': 0, '2': 3 });
    expect(parsePreviewPartPages({})).toEqual({});
  });
  it('parsePreviewPartPages は負・小数・番号でないキーを含むと null', () => {
    expect(parsePreviewPartPages({ '1': -1 })).toBeNull();
    expect(parsePreviewPartPages({ '1': 1.5 })).toBeNull();
    expect(parsePreviewPartPages({ '1': '2' })).toBeNull();
    expect(parsePreviewPartPages({ x: 1 })).toBeNull();
    expect(parsePreviewPartPages([1])).toBeNull();
    expect(parsePreviewPartPages(null)).toBeNull();
  });
});
