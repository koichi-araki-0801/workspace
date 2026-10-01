// =============================================================================
// cssRebase.test.ts — リクエスト CSS の相対 url() を css/ 基準へ付け替える関数の固定
// =============================================================================
import { describe, expect, it } from 'vitest';
import { collectCssUrlCandidates, findExternalRefsInCss } from '../src/security/cssExternalRefs.js';
import { REQUEST_CSS_BASE, rebaseCssUrls } from '../src/security/cssRebase.js';

const rebase = (css: string): string => rebaseCssUrls(css, REQUEST_CSS_BASE);

describe('rebaseCssUrls', () => {
  it('相対 url() を css/ 基準の配信ルート相対へ直し、引用形で書き戻す', () => {
    expect(rebase('@font-face{src:url(fonts/a.woff2)}')).toBe(
      '@font-face{src:url("css/fonts/a.woff2")}',
    );
  });

  it('../ は正規化する(css/../js/x.js → js/x.js)', () => {
    expect(rebase('.a{background:url(../js/x.png)}')).toBe('.a{background:url("js/x.png")}');
  });

  it('ルートの外へ出る形は原文のまま残す', () => {
    const css = '.a{background:url(../../x.png)}';
    expect(rebase(css)).toBe(css);
  });

  it.each([
    ['data:', '.a{background:url(data:image/png;base64,AAAA)}'],
    ['断片', '.a{fill:url(#grad)}'],
    ['ルート絶対', '.a{background:url(/x.png)}'],
    ['絶対 URL', '.a{background:url(https://example.com/x.png)}'],
    ['scheme 相対', '.a{background:url(//example.com/x.png)}'],
  ])('%s は付け替えない', (_label, css) => {
    expect(rebase(css)).toBe(css);
  });

  it('local() と引用符文字列は付け替えない', () => {
    const css =
      '@font-face{src:local("fonts/a"),url(fonts/a.woff2)} .b{content:"fonts/x"}' +
      ' .c{background:image-set("fonts/y.png" 1x)}';
    expect(rebase(css)).toBe(
      '@font-face{src:local("fonts/a"),url("css/fonts/a.woff2")} .b{content:"fonts/x"}' +
        ' .c{background:image-set("fonts/y.png" 1x)}',
    );
  });

  it('クエリと断片は保つ', () => {
    expect(rebase('@font-face{src:url(fonts/a.eot?#iefix)}')).toBe(
      '@font-face{src:url("css/fonts/a.eot?#iefix")}',
    );
  });

  it('空白・括弧・引用符・エスケープを含む値でも CSS を壊さない', () => {
    const out = rebase(
      '.a{background:url("fonts/a b.png")} .b{background:url("fonts/x).png")} ' +
        '.c{background:url(\\66 onts/e.png)} .d{color:red}',
    );
    expect(out).toContain('url("css/fonts/a%20b.png")');
    expect(out).toContain('url("css/fonts/x).png")');
    expect(out).toContain('url("css/fonts/e.png")');
    // 後続の規則が生き残る(引用なしで書き戻すと `)` で url() が閉じて崩れる)。
    expect(out).toContain('.d{color:red}');
    expect(collectCssUrlCandidates(out)).toEqual([
      'css/fonts/a%20b.png',
      'css/fonts/x).png',
      'css/fonts/e.png',
    ]);
  });

  it('エスケープで隠した </style> を生の字面へ戻さない', () => {
    const out = rebase('.a{background:url(fonts/\\3c /style\\3e x.png)}');
    expect(out.toLowerCase()).not.toContain('</style');
  });

  it('外部参照の検査結果を変えない(付け替え前後で同じ)', () => {
    const css =
      '.a{background:url(fonts/a.png)} .b{background:url(https://evil/x)} @import "x.css";';
    expect(findExternalRefsInCss(rebase(css))).toEqual(findExternalRefsInCss(css));
  });

  it('2 回掛けると二重になる(冪等ではない = 呼び出しは入口 1 回に限る理由)', () => {
    expect(rebase(rebase('.a{background:url(fonts/a.png)}'))).toBe(
      '.a{background:url("css/css/fonts/a.png")}',
    );
  });
});
