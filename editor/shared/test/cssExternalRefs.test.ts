// =============================================================================
// cssExternalRefs.test.ts — CSS 外部参照ゲートの迂回入力を主張する
// =============================================================================
// このゲートが緩むと、上流の 400(`server/src/security/externalRefs.ts`)とテンプレ JS の
// 不変性照合(`templateScripts.ts` の `pushCssUnits`)が**同時に静かに素通し**になる。
// よって本テストの重心は「トークナイザが仕様どおり終端するか」= 迂回入力で参照が
// **報告されること**の主張に置き、正常系は誤検知しないことの回帰に絞る。
import { describe, expect, it } from 'vitest';
import {
  collectCssStringsInFunctions,
  collectCssStructure,
  collectCssUrlCandidates,
  collectCssUrlSpans,
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

// ── URL パーサが外す文字(前後の C0 制御文字と空白、途中の TAB/LF/CR)──
// ブラウザは CSS のエスケープを解いた値を URL パーサへ渡し、URL パーサは前後の U+0020 以下を
// 捨て、TAB/LF/CR を位置を問わず消す。エスケープで書いた `\1 ` や `\9 ` が残ったまま scheme の
// 形を見ると「相対参照」と読み、ブラウザが取りに行く `http://…` を素通しする。
describe('URL パーサが外す文字を挟んだ外部 URL', () => {
  it.each([
    ['前に U+0001', String.raw`.a{background:url("\1 http://evil.example/x")}`],
    ['scheme の途中に TAB', String.raw`.a{background:url("ht\9 tp://evil.example/x")}`],
    [
      '引用符文字列の scheme の途中に LF',
      String.raw`.a{background:image-set("ht\a tp://evil.example/x" 1x)}`,
    ],
    ['未引用 url() の前に U+001F', String.raw`.a{background:url(\1f http://evil.example/x)}`],
  ])('%s も報告する', (_label, css) => {
    expect(findExternalRefsInCss(css)).not.toEqual([]);
  });

  it.each([
    `${String.fromCharCode(1)}http://evil.example/x`,
    `ht${String.fromCharCode(9)}tp://evil.example/x`,
    `https:${LF}//evil.example/x`,
    `/${CR}/evil.example/x`,
    `d${LF}ata:text/html,x`,
  ])('%j は外部参照(自己完結ではない)', (url) => {
    expect(isSelfContainedUrl(url)).toBe(false);
  });

  it('外す文字を挟んでも同梱資産・#id・許可した data: は通す(遮断しすぎない)', () => {
    expect(isSelfContainedUrl(`${String.fromCharCode(1)}#g`)).toBe(true);
    expect(isSelfContainedUrl(`fonts/a${String.fromCharCode(9)}b.woff2`)).toBe(true);
    expect(isSelfContainedUrl(`data:image/p${LF}ng;base64,A`)).toBe(true);
    expect(isAllowedDataUrl(`${String.fromCharCode(1)}data:image/png;base64,A`)).toBe(true);
  });
});

// ── CSS の入力前処理(CRLF・CR・FF は LF へ畳まれる)──
// 16 進エスケープの後ろの空白は 1 個だけ食われる。ブラウザは前処理で CRLF を LF 1 個にしてから
// 字句を読むので、`\75` + CRLF + `rl(` は `url(` になる。原文のまま読むと CR だけが食われ、LF が
// ident を切って `url(` を見落とす。
describe('CRLF をまたぐエスケープ', () => {
  it.each([
    ['CRLF', `${CR}${LF}`],
    ['CR', CR],
    ['FF', FF],
  ])('エスケープ `75` + %s + `rl(` を url() として読む', (_label, nl) => {
    const css = `${String.raw`.a{background:\75`}${nl}rl(http://evil.example/x)}`;
    expect(findExternalRefsInCss(css)).toEqual(['url(http://evil.example/x)']);
  });

  it('CRLF の後ろの位置は原文のオフセットで返す(置換・規則分割がずれない)', () => {
    const css = `.a{}${CR}${LF}${CR}${LF}.b{background:url(x.png)}${CR}${LF}.c{}`;
    const [span] = collectCssUrlSpans(css);
    expect(span).toEqual({
      value: 'x.png',
      start: css.indexOf('url('),
      end: css.indexOf(')') + 1,
    });
    const punct = collectCssStructure(css).punct.map((p) => p.at);
    const expected = [...css].flatMap((ch, at) => ('{};'.includes(ch) ? [at] : []));
    expect(punct).toEqual(expected);
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

  it('src 宣言は従来どおり判定する', () => {
    const [a, b] = collectCssUrlSpansInContext('@font-face{ src:url(#a),url(#b);x:url(#c)}');
    expect([a?.inFontFaceSrc, b?.inFontFaceSrc]).toEqual([true, true]);
    const spans = collectCssUrlSpansInContext('@font-face{src:url(#a);x:url(#c)}');
    expect(spans.map((x) => x.inFontFaceSrc)).toEqual([true, false]);
  });
});

describe('collectCssStructure — 規則分割のための構造(検査と同じ走査器)', () => {
  it('コメント・文字列の中の括弧は拾わず、位置と at-rule 名を返す', () => {
    const css = '/* x */@media a{.b{c:"{"}}';
    const s = collectCssStructure(css);
    expect(s.comments).toEqual([{ start: 0, end: 7 }]);
    expect([...s.atRules]).toEqual([[7, 'media']]);
    expect(s.punct).toEqual([
      { ch: '{', at: 15 },
      { ch: '{', at: 18 },
      { ch: '}', at: 24 },
      { ch: '}', at: 25 },
    ]);
  });

  it('url() の中の括弧と ; は拾わない', () => {
    expect(collectCssStructure('.a{background:url(x{;}.png)}').punct).toEqual([
      { ch: '{', at: 2 },
      { ch: '}', at: 27 },
    ]);
  });

  it('閉じていないコメントは末尾まで', () => {
    expect(collectCssStructure('.a{}/* x').comments).toEqual([{ start: 4, end: 8 }]);
  });

  it('エスケープした at-rule 名は解決して返す', () => {
    expect([...collectCssStructure('@\\6d edia x{}').atRules]).toEqual([[0, 'media']]);
  });
});

describe('collectCssStringsInFunctions — 関数の引数にある引用符の文字列', () => {
  it('関数名(小文字・エスケープ解決後)と値の組を、いちばん内側の関数で返す', () => {
    expect(
      collectCssStringsInFunctions(
        String.raw`.a{background:IMAGE-SET("a.png" 1x, \69mage-set('b\'c'));x:f(g("d"), "e")}`,
      ),
    ).toEqual([
      { value: 'a.png', fn: 'image-set' },
      { value: "b'c", fn: 'image-set' },
      { value: 'd', fn: 'g' },
      { value: 'e', fn: 'f' },
    ]);
  });

  it('関数の外の文字列・コメント・url() の中は数えない', () => {
    expect(
      collectCssStringsInFunctions(
        '/* f("x") */.a{font-family:"F";fill:url("y.png");content:"z"} f() "w" @namespace "n";',
      ),
    ).toEqual([]);
  });

  it('関数名の後に空白やコメントを挟んだ括弧は関数ではなく、外側の関数を引き継ぐ', () => {
    expect(collectCssStringsInFunctions('.a{b:f/**/("x")}')).toEqual([]);
    expect(collectCssStringsInFunctions('.a{b:f(("x"))}')).toEqual([{ value: 'x', fn: 'f' }]);
  });

  it('閉じた関数の後ろの文字列は関数の外', () => {
    expect(collectCssStringsInFunctions('.a{b:f("x") "y"}')).toEqual([{ value: 'x', fn: 'f' }]);
  });

  it('カスタムプロパティと initial-value の最上位の文字列は関数名を空で返す', () => {
    expect(
      collectCssStringsInFunctions(
        String.raw`.a{--u:"x";\2d-v:"y";color:"z"}@property --w{syntax:"*";INITIAL-VALUE:"q"}`,
      ),
    ).toEqual([
      { value: 'x', fn: '' },
      { value: 'y', fn: '' },
      { value: 'q', fn: '' },
    ]);
  });

  it('関数の中の ; や } では関数を抜けない(ブラウザも関数を ) まで読む)', () => {
    expect(collectCssStringsInFunctions('.a{b:f(;}.c{d:"x"')).toEqual([{ value: 'x', fn: 'f' }]);
  });

  it('カスタムプロパティの値の {} は値のブロックで、規則のブロックとして宣言を区切らない', () => {
    expect(collectCssStringsInFunctions('.a{--u:{} "x"}.b{--v:{"y"}}')).toEqual([
      { value: 'x', fn: '' },
      { value: 'y', fn: '' },
    ]);
    // 普通のプロパティ名の後の `{` は入れ子の規則(`a:hover{…}`)なので、中の宣言を読む。
    expect(collectCssStringsInFunctions('.p{a:hover{--u:"z";color:"w"}}')).toEqual([
      { value: 'z', fn: '' },
    ]);
  });

  it('[] や {} の中の ) では関数を閉じない(閉じ文字は最も内側の括弧と合うものだけ)', () => {
    expect(collectCssStringsInFunctions('.a{b:f({)} "x") "y";c:g([)] "z")}')).toEqual([
      { value: 'x', fn: 'f' },
      { value: 'z', fn: 'g' },
    ]);
  });
});
