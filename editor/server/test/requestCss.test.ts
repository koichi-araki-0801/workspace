// =============================================================================
// requestCss.test.ts — build 入口でのリクエスト CSS の付け替え
// =============================================================================
import { describe, expect, it } from 'vitest';
import { rebaseRequestCss } from '../src/vivliostyle/requestCss.js';

describe('rebaseRequestCss', () => {
  it('css/ 基準へ付け替える', () => {
    expect(rebaseRequestCss('@font-face{src:url(fonts/a.woff2)}')).toBe(
      '@font-face{src:url("css/fonts/a.woff2")}',
    );
  });

  it('未指定・空は空文字', () => {
    expect(rebaseRequestCss(undefined)).toBe('');
    expect(rebaseRequestCss('')).toBe('');
  });
});
