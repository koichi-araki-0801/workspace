// =============================================================================
// libFundImages.test.ts — ファンド別画像の配信 URL とファイル名判定の固定
// =============================================================================
import { describe, expect, it } from 'vitest';
import { fundImageFileOf, fundImageMime, fundImageUrl } from '@/lib/fundImages';

describe('fundImageFileOf', () => {
  it('images 直下の許可拡張子だけをファイル名にする', () => {
    expect(fundImageFileOf('images/510037_logo.svg')).toBe('510037_logo.svg');
    expect(fundImageFileOf('images/510037_photo.JPG')).toBe('510037_photo.JPG');
    expect(fundImageFileOf('./images/510037_logo.png')).toBe('510037_logo.png');
  });

  it.each([
    'images/sub/510037_logo.svg',
    'images/510037_anim.gif',
    'css/510037_logo.svg',
    'images/../css/x.svg',
    'https://evil.example/images/x.svg',
    '/images/x.svg',
    'images/__proto__',
    'images/',
  ])('%s は対象外', (ref) => {
    expect(fundImageFileOf(ref)).toBeUndefined();
  });
});

describe('fundImageUrl / fundImageMime', () => {
  it('配信 URL は apiPaths から作り、ファイル名を符号化する', () => {
    expect(fundImageUrl('510037_logo.svg')).toBe('/api/fund-assets/images/510037_logo.svg');
    expect(fundImageUrl('a b.svg')).toBe('/api/fund-assets/images/a%20b.svg');
  });

  it('拡張子から MIME を引く(大小文字を問わない)', () => {
    expect(fundImageMime('a.SVG')).toBe('image/svg+xml');
    expect(fundImageMime('a.jpeg')).toBe('image/jpeg');
    expect(fundImageMime('a.gif')).toBeUndefined();
    expect(fundImageMime('noext')).toBeUndefined();
  });
});
