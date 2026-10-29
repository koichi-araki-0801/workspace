// =============================================================================
// hostProtocol.test.ts — プレビューホストの資産 URL の組み立て
// =============================================================================
import { describe, expect, it } from 'vitest';
import { MAX_TOP_LEVEL_BLOCKS } from '../src/html/reviewDiff/htmlDiff.js';
import {
  isPreviewPartNo,
  PREVIEW_HOST_BASE,
  PREVIEW_MAX_PART_KEYS,
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
  it('isPreviewPartNo は 1 始まりの 1〜5 桁の数字の正規形だけ(番号は 1 から振る)', () => {
    for (const ok of ['1', '7', '12345', '99999']) expect(isPreviewPartNo(ok)).toBe(true);
    // '01' と '1' が別のキーとして二重に通らないよう、先頭に 0 を持つ形は拒む。'0' は振らない番号。
    for (const ng of [
      '',
      '0',
      '123456',
      '-1',
      '1.5',
      'a1',
      ' 1',
      '１',
      '00001',
      '01',
      '00',
      1,
      null,
      undefined,
    ]) {
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
  it('境界: states の値が null・__proto__ キー・キーの個数の上限', () => {
    expect(parsePreviewMarks({ ...base, states: { '1': null } })).toBeNull();
    expect(
      parsePreviewMarks({ ...base, states: JSON.parse('{"__proto__":"approved"}') }),
    ).toBeNull();
    expect(parsePreviewMarks({ ...base, selected: '01' })).toBeNull();
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 'pending']));
    expect(parsePreviewMarks({ ...base, states: many(PREVIEW_MAX_PART_KEYS) })).not.toBeNull();
    expect(parsePreviewMarks({ ...base, states: many(PREVIEW_MAX_PART_KEYS + 1) })).toBeNull();
  });
});

describe('PREVIEW_MAX_PART_KEYS', () => {
  it('差分の最上位ブロックの上限と同じ値(番号はそれ以上振られない)', () => {
    expect(PREVIEW_MAX_PART_KEYS).toBe(MAX_TOP_LEVEL_BLOCKS);
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
  it('境界: NaN・Infinity・安全な整数を超える値・__proto__・キーの個数の上限', () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, 1e300]) {
      expect(parsePreviewPartPages({ '1': n }), String(n)).toBeNull();
    }
    expect(parsePreviewPartPages(JSON.parse('{"__proto__":1}'))).toBeNull();
    expect(parsePreviewPartPages({ '01': 1 })).toBeNull();
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 0]));
    expect(parsePreviewPartPages(many(PREVIEW_MAX_PART_KEYS))).not.toBeNull();
    expect(parsePreviewPartPages(many(PREVIEW_MAX_PART_KEYS + 1))).toBeNull();
  });
});
