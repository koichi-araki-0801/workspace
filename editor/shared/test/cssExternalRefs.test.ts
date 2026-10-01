// =============================================================================
// cssExternalRefs.test.ts — CSS 外部参照ゲートの迂回入力を主張する
// =============================================================================
// このゲートが緩むと、上流の 400(`server/src/security/externalRefs.ts`)とテンプレ JS の
// 不変性照合(`templateScripts.ts` の `pushCssUnits`)が**同時に静かに素通し**になる。
// よって本テストの重心は「トークナイザが仕様どおり終端するか」= 迂回入力で参照が
// **報告されること**の主張に置き、正常系は誤検知しないことの回帰に絞る。
import { describe, expect, it } from 'vitest';
import {
  collectCssUrlCandidates,
  collectCssUrlSpansInContext,
  findExternalRefsInCss,
  isAllowedDataUrl,
  isSelfContainedUrl,
} from '../src/security/cssExternalRefs.js';

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const FF = String.fromCharCode(0x0c);

// ── 引用符文字列は改行でも終端する(CSS Syntax 4.3.5 の bad-string-token)──
// 引用符と EOF でしか終端しない実装は、1 行未終端の引用符から先の**スタイルシート全体**を
// 「文字列の中身」として飲み込み、検査が 0 件を返す。ブラウザはその宣言だけを捨てて
// 次の `;`/`}` から再開するので、飲み込まれた規則は実際には適用される。
describe('未終端の引用符(改行終端)で以降が検査から消えない', () => {
  it.each([
    ['LF', LF],
    ['CRLF', `${CR}${LF}`],
    ['CR', CR],
    ['FF', FF],
  ])('%s で終端し、続く url() の絶対 URL を報告する', (_label, nl) => {
    const css = `.a{content:"oops${nl}}${nl}body{background:url(http://evil.example/leak.png)}`;
    expect(findExternalRefsInCss(css)).toContain('url(http://evil.example/leak.png)');
  });

  it('未終端の引用符に続く @import を報告する', () => {
    const css = `.a{content:'oops${LF}}${LF}@import url(http://evil.example/x.css);`;
    expect(findExternalRefsInCss(css)).toContain('@import');
  });

  it('url("…) の中の未終端引用符でも走査が再開する(bad-url を飲み込まない)', () => {
    const css = `.a{background:url("oops${LF}}${LF}@import url(http://evil.example/x.css);`;
    expect(findExternalRefsInCss(css)).toContain('@import');
  });

  it('未終端引用符の先にある url() を staging 側の候補列挙も見る(検査と同じ物差し)', () => {
    const css = `.a{content:"oops${LF}}${LF}.b{background:url(fonts/a.woff2)}`;
    expect(collectCssUrlCandidates(css)).toContain('fonts/a.woff2');
  });

  it('`\\` + 改行は行継続で、文字列は終端しない(仕様どおり・誤検知しない)', () => {
    const css = `.a{content:"ab\\${LF}cd"}`;
    expect(findExternalRefsInCss(css)).toEqual([]);
  });

  it('普通の複数行 CSS は 1 件も報告しない(業務を止めない)', () => {
    const css = `@page{margin:10mm}${LF}.a{content:"注: 説明";background:url(img/logo.png)}`;
    expect(findExternalRefsInCss(css)).toEqual([]);
  });
});

// ── `\` は特殊スキームの base に対して `/` と同一視される ──
// WHATWG URL パーサは http(s) 等の base に対し `\` を `/` として扱うので、下記はすべて
// `http://evil.example/x` へ解決される。`startsWith('//')` だけを見る判定は全部素通しする。
describe('バックスラッシュで書いた scheme 相対 URL', () => {
  it.each([
    '\\\\evil.example/x',
    '/\\evil.example/x',
    '\\/evil.example/x',
    '  \\\\evil.example/x  ',
  ])('%s は外部参照(自己完結ではない)', (url) => {
    expect(isSelfContainedUrl(url)).toBe(false);
  });

  it('CSS エスケープで書いた `\\5c\\5c host/x` も報告する', () => {
    // `\5c` = U+005C(`\`)。エスケープ解決後は `\\evil.example/x`。
    const css = '.a{background:url(\\5c\\5c evil.example/x)}';
    expect(findExternalRefsInCss(css)).not.toEqual([]);
  });

  it('同梱資産への相対参照は通す(遮断しすぎない)', () => {
    expect(isSelfContainedUrl('fonts/BIZUDPGothic.woff2')).toBe(true);
    expect(isSelfContainedUrl('./css/510037.css')).toBe(true);
    expect(isSelfContainedUrl('#clip1')).toBe(true);
  });
});

describe('isAllowedDataUrl', () => {
  it('許可リストの data: URI だけを真にする(SVG は入れない)', () => {
    expect(isAllowedDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedDataUrl(' DATA:image/JPEG;base64,AAAA')).toBe(true);
    expect(isAllowedDataUrl('data:image/svg+xml,%3Csvg%3E')).toBe(false);
    expect(isAllowedDataUrl('data:text/html,x')).toBe(false);
    expect(isAllowedDataUrl('https://example.com/x.png')).toBe(false);
  });

  it('isSelfContainedUrl の data: 判定と一致する', () => {
    for (const url of [
      'data:image/png;base64,A',
      'data:image/svg+xml,x',
      'data:font/woff2;base64,A',
    ]) {
      expect(isSelfContainedUrl(url)).toBe(isAllowedDataUrl(url));
    }
  });
});

// ── @font-face の src 判定は宣言ごとに 1 回(url() ごとに頭から見直さない)──
describe('collectCssUrlSpansInContext は入力サイズに対して線形', () => {
  const build = (n: number): string => `@font-face{${' '.repeat(10 * n)}x:${'url(#a)'.repeat(n)}}`;
  const timed = (n: number): number => {
    const css = build(n);
    const t0 = performance.now();
    const spans = collectCssUrlSpansInContext(css);
    const ms = performance.now() - t0;
    expect(spans).toHaveLength(n);
    expect(spans.every((x) => !x.inFontFaceSrc)).toBe(true);
    return ms;
  };

  it('長い空白の後に x: と url() を大量に並べても終わる(約 1MB)', () => {
    expect(timed(60_000)).toBeLessThan(2000);
  });

  it('サイズを 2 倍にしても時間が 4 倍近くまで増えない', () => {
    timed(5_000);
    const small = Math.max(timed(30_000), 1);
    const large = timed(60_000);
    expect(large / small).toBeLessThan(3.5);
  });

  it('src 宣言は従来どおり判定する', () => {
    const [a, b] = collectCssUrlSpansInContext('@font-face{ src:url(#a),url(#b);x:url(#c)}');
    expect([a?.inFontFaceSrc, b?.inFontFaceSrc]).toEqual([true, true]);
    const spans = collectCssUrlSpansInContext('@font-face{src:url(#a);x:url(#c)}');
    expect(spans.map((x) => x.inFontFaceSrc)).toEqual([true, false]);
  });
});
