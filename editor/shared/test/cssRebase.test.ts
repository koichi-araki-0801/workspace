// =============================================================================
// cssRebase.test.ts — リクエスト CSS の相対 url() を文書基準へ付け替える関数の固定
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  type CssUrlSpan,
  collectCssUrlCandidates,
  collectCssUrlSpans,
  findExternalRefsInCss,
} from '../src/security/cssExternalRefs.js';
import {
  DOC_CSS_PATH,
  rebaseCssForDoc,
  replaceSpansFromEnd,
  rewriteCssUrlSpans,
} from '../src/security/cssRebase.js';
import { resolveDocAssetPath } from '../src/security/htmlExternalRefs.js';

describe('DOC_CSS_PATH — CSS の参照元として web も使う論理パス', () => {
  it('css/ 直下の CSS の位置を表し、そこから解いた参照が rebaseCssForDoc の結果と一致する', () => {
    expect(DOC_CSS_PATH).toBe('css/template.css');
    expect(resolveDocAssetPath('fonts/a.woff2', DOC_CSS_PATH)).toBe('css/fonts/a.woff2');
    expect(rebaseCssForDoc('.a{background:url(fonts/a.woff2)}')).toBe(
      '.a{background:url("../css/fonts/a.woff2")}',
    );
  });
});

describe('rebaseCssForDoc — css/<テンプレ>.css の位置の CSS を doc/ から見た形へ直す', () => {
  it.each([
    ['@font-face{src:url(fonts/a.woff2)}', '@font-face{src:url("../css/fonts/a.woff2")}'],
    ['.a{background:url(../images/b.png)}', '.a{background:url("../images/b.png")}'],
    ['.a{background:url(../images/smtam/qr.svg)}', '.a{background:url("../images/smtam/qr.svg")}'],
    ['.a{background:url("x.png?v=1#f")}', '.a{background:url("../css/x.png?v=1#f")}'],
    [
      '@font-face{src:url(fonts/明朝.woff2)}',
      '@font-face{src:url("../css/fonts/%E6%98%8E%E6%9C%9D.woff2")}',
    ],
  ])('%s → %s', (css, expected) => {
    expect(rebaseCssForDoc(css)).toBe(expected);
  });

  it.each([
    ['ルートの外', '.a{background:url(../../x.png)}'],
    ['doc/ 配下', '.a{background:url(../doc/x.png)}'],
    ['data:', '.a{background:url(data:image/png;base64,AAAA)}'],
    ['断片', '.a{fill:url(#grad)}'],
    ['ルート絶対', '.a{background:url(/x.png)}'],
    ['絶対 URL', '.a{background:url(https://example.com/x.png)}'],
    ['scheme 相対', '.a{background:url(//example.com/x.png)}'],
  ])('%s は付け替えない', (_label, css) => {
    expect(rebaseCssForDoc(css)).toBe(css);
  });

  it('local() と引用符文字列は付け替えない', () => {
    expect(
      rebaseCssForDoc('@font-face{src:local("fonts/a"),url(fonts/a.woff2)} .b{content:"fonts/x"}'),
    ).toBe('@font-face{src:local("fonts/a"),url("../css/fonts/a.woff2")} .b{content:"fonts/x"}');
  });

  it('2 回掛けても形が変わらない(doc/ と css/ は同じ深さの兄弟)', () => {
    const css = '@font-face{src:url(fonts/a.woff2)} .a{background:url(../images/b.png)}';
    const once = rebaseCssForDoc(css);
    expect(rebaseCssForDoc(once)).toBe(once);
  });

  it('空白・括弧・引用符・エスケープを含む値でも CSS を壊さない', () => {
    const out = rebaseCssForDoc(
      '.a{background:url("fonts/a b.png")} .b{background:url("fonts/x).png")} ' +
        '.c{background:url(\\66 onts/e.png)} .d{color:red}',
    );
    expect(out).toContain('url("../css/fonts/a%20b.png")');
    expect(out).toContain('url("../css/fonts/x).png")');
    expect(out).toContain('url("../css/fonts/e.png")');
    // 後続の規則が生き残る(引用なしで書き戻すと `)` で url() が閉じて崩れる)。
    expect(out).toContain('.d{color:red}');
    expect(collectCssUrlCandidates(out)).toEqual([
      '../css/fonts/a%20b.png',
      '../css/fonts/x).png',
      '../css/fonts/e.png',
    ]);
  });

  it('エスケープで隠した </style> を生の字面へ戻さない', () => {
    const out = rebaseCssForDoc('.a{background:url(fonts/\\3c /style\\3e x.png)}');
    expect(out.toLowerCase()).not.toContain('</style');
  });

  it('外部参照の検査結果を変えない(付け替え前後で同じ)', () => {
    const css =
      '.a{background:url(fonts/a.png)} .b{background:url(https://evil/x)} @import "x.css";';
    expect(findExternalRefsInCss(rebaseCssForDoc(css))).toEqual(findExternalRefsInCss(css));
  });
});

// 呼び出し側が必要とする結果(後ろから `slice` で繋ぎ直すループ)を参照実装として持ち、
// `rewriteCssUrlSpans` が同じ結果を返すことを確かめる。
describe('rewriteCssUrlSpans — url() を後ろから置き換える', () => {
  const oldLoop = (css: string, f: (span: CssUrlSpan) => string | undefined): string => {
    let out = css;
    for (const span of [...collectCssUrlSpans(css)].reverse()) {
      const next = f(span);
      if (next === undefined) continue;
      out = `${out.slice(0, span.start)}${next}${out.slice(span.end)}`;
    }
    return out;
  };
  const inputs = [
    '',
    '.a{color:red}',
    '.a{background:url(x.png)}',
    `.a{background:url(x.png),url("y.png")} .b{src:url( 'z.woff2' ) format("woff2")}`,
    '@font-face{src:url(fonts/a.woff2)}@media print{.c{background:url(../images/b.svg)}}',
    '.a{content:"url(not-a-url)";background:url(a\\29 .png)}',
  ];
  const fs: Array<(span: CssUrlSpan) => string | undefined> = [
    () => undefined,
    () => 'none',
    (span) => (span.value.endsWith('.png') ? `url("${span.value}?v")` : undefined),
    (span) => `url(${span.value.length}${'x'.repeat(span.end - span.start)})`,
  ];
  it.each(inputs)('%j: 置き換え前のループと同じ結果になる', (css) => {
    for (const f of fs) expect(rewriteCssUrlSpans(css, f)).toBe(oldLoop(css, f));
  });

  it('undefined を返した url() は残し、文字列を返した url() だけを置き換える', () => {
    expect(
      rewriteCssUrlSpans('.a{x:url(a.png);y:url(b.svg)}', (s) =>
        s.value === 'b.svg' ? 'none' : undefined,
      ),
    ).toBe('.a{x:url(a.png);y:none}');
  });
});

describe('replaceSpansFromEnd — 範囲の列を後ろから置き換える', () => {
  it('範囲を後ろから置き換え、先行する範囲の位置を保つ', () => {
    const spans = [
      { start: 0, end: 1 },
      { start: 2, end: 4 },
    ];
    expect(replaceSpansFromEnd('abcdef', spans, (s) => (s.start === 0 ? 'XYZ' : '-'))).toBe(
      'XYZb-ef',
    );
    expect(replaceSpansFromEnd('abc', spans.slice(0, 1), () => undefined)).toBe('abc');
  });
});
