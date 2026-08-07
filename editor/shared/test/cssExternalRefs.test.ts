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
  findExternalRefsInCss,
  isSelfContainedUrl,
} from '../src/security/cssExternalRefs.js';

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const FF = String.fromCharCode(0x0c);

// ── F8: 引用符文字列は改行でも終端する(CSS Syntax 4.3.5 の bad-string-token)──
// 引用符と EOF でしか終端しない版は、1 行未終端の引用符から先の**スタイルシート全体**を
// 「文字列の中身」として飲み込み、検査が 0 件を返した。ブラウザはその宣言だけを捨てて
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

// ── F24: `\` は特殊スキームの base に対して `/` と同一視される ──
// WHATWG URL パーサは http(s) 等の base に対し `\` を `/` として扱うので、下記はすべて
// `http://evil.example/x` へ解決される。`startsWith('//')` だけを見ていた版は全部素通しした。
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
