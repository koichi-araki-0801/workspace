// =============================================================================
// htmlExternalRefs.test.ts — 「同梱資産は通り、オリジン外は落ちる」の両方を主張する
// =============================================================================
// テンプレは CSS・フォント・JS を相対パスで参照するので、**相対参照が通ること**は
// 遮断が効くことと同じだけ重要な要件である。片側だけ書くと、次に触る人が
// 「全部落とせば安全」へ倒して業務を止める。
import { describe, expect, it } from 'vitest';
import { normalizeHtmlUrlValue } from '../src/security/htmlEntities.js';
import {
  fetchUrlAttrsFor,
  findExternalRefsInTag,
  isFetchUrlAttr,
  nestedHtmlAttrsFor,
  resolveServedAssetPath,
} from '../src/security/htmlExternalRefs.js';

const TAB = String.fromCharCode(0x09);
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);

describe('findExternalRefsInTag — 同梱資産への相対参照は通る', () => {
  it.each([
    ['link', 'href', 'css/510037.css'],
    ['link', 'href', './css/510037.css'],
    ['script', 'src', 'js/column-width.js'],
    ['img', 'src', 'img/logo.png'],
    ['img', 'src', 'data:image/png;base64,AAAA'],
    ['use', 'xlink:href', '#marker'],
    ['use', 'href', '#marker'],
    // path の中の `:` はスキームではない。
    ['script', 'src', 'js/a:b/c.js'],
  ])('<%s %s="%s"> は外部参照ではない', (tag, attr, value) => {
    expect(findExternalRefsInTag(tag, [{ name: attr, value }])).toEqual([]);
  });
});

describe('findExternalRefsInTag — オリジン外の絶対参照は落ちる', () => {
  it.each([
    ['link', 'href', 'https://evil.example/x.css'],
    ['link', 'href', 'http://evil.example/x.css'],
    // scheme 相対。ホスト部が外なので絶対参照と同じ。
    ['script', 'src', '//evil.example/x.js'],
    ['img', 'src', 'file:///C:/Windows/win.ini'],
    // 許可リストに無い data:(SVG は文脈次第でスクリプトを持ち込む)。
    ['img', 'src', 'data:image/svg+xml;base64,AAAA'],
    ['iframe', 'src', 'https://evil.example/'],
    ['object', 'data', 'https://evil.example/x.swf'],
    ['image', 'xlink:href', 'https://evil.example/x.png'],
  ])('<%s %s="%s"> は外部参照として報告される', (tag, attr, value) => {
    expect(findExternalRefsInTag(tag, [{ name: attr, value }])).toHaveLength(1);
  });

  it('大文字の属性名でも取りこぼさない', () => {
    expect(
      findExternalRefsInTag('SCRIPT', [{ name: 'SRC', value: 'https://evil.example/x.js' }]),
    ).toHaveLength(1);
  });

  it('srcset は候補を分解して全部見る(1 つでも外部なら報告)', () => {
    const refs = findExternalRefsInTag('img', [
      { name: 'srcset', value: 'img/a.png 1x, https://evil.example/b.png 2x' },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toContain('evil.example');
  });
});

describe('取得を起こさない属性は検査しない', () => {
  // `<a href>` は利用者の操作で初めて遷移する。組版中に 1 バイトも取りに行かないので、
  // ここを弾くと「引用元 URL を書いた帳票」が全部 400 になるだけで egress は減らない。
  it('<a href="https://…"> は外部参照として扱わない', () => {
    expect(findExternalRefsInTag('a', [{ name: 'href', value: 'https://example.com/' }])).toEqual(
      [],
    );
    expect(fetchUrlAttrsFor('a')).toEqual([]);
  });

  it('取得系でない属性(title / data-*)は素通し', () => {
    expect(
      findExternalRefsInTag('img', [
        { name: 'title', value: 'https://evil.example/x' },
        { name: 'data-note', value: '//evil.example/y' },
      ]),
    ).toEqual([]);
  });

  it('isFetchUrlAttr は要素と属性の組で判定する', () => {
    expect(isFetchUrlAttr('script', 'src')).toBe(true);
    // SVG の `<script>` は `href` でも外部 JS を引くので、これも取得系として見る。
    expect(isFetchUrlAttr('script', 'href')).toBe(true);
    expect(isFetchUrlAttr('script', 'rel')).toBe(false);
    expect(isFetchUrlAttr('div', 'src')).toBe(false);
  });
});

describe('resolveServedAssetPath — 配信ルート相対へ正規化できるか', () => {
  it.each([
    ['css/510037.css', 'css/510037.css'],
    ['./css/510037.css', 'css/510037.css'],
    ['css/./510037.css', 'css/510037.css'],
    ['fonts/sub/../x.woff2', 'fonts/x.woff2'],
    ['css/510037.css?v=1', 'css/510037.css'],
    ['css/510037.css#a', 'css/510037.css'],
    ['js/%E6%97%A5.js', 'js/日.js'],
  ])('%s → %s', (input, expected) => {
    expect(resolveServedAssetPath(input)).toBe(expected);
  });

  it.each([
    ['https://evil.example/x.css', '絶対 URL'],
    ['//evil.example/x.css', 'scheme 相対'],
    ['/css/x.css', 'ルート絶対(配信ルート配下ではない)'],
    ['../secret.css', 'ルート外へ出る'],
    ['css/../../secret.css', '途中でルート外へ出る'],
    ['', '空'],
    ['#frag', '断片のみ'],
    ['css\\510037.css', 'バックスラッシュ区切り'],
    ['%E0%A4%A', '復号不能'],
  ])('%s(%s)は解決しない', (input) => {
    expect(resolveServedAssetPath(input)).toBeUndefined();
  });
});

// ── 迂回入力 ── ブラウザは属性値の文字参照を解き、URL から TAB/LF/CR を落とす。
// 検査器は「引用符を外しただけの原文」を見るので、正規化しないと**この差が全部穴になる**。
// 実測でここに並ぶ入力はいずれも「外部参照 0 件」で 400 ゲートを通り抜けていた。
describe('findExternalRefsInTag — 実体参照・制御文字での迂回は通さない', () => {
  it.each([
    ['10 進の文字参照', '&#104;ttps://evil.example/x.png'],
    ['16 進の文字参照', '&#x68;ttps://evil.example/x.png'],
    ['セミコロン省略', '&#104ttps://evil.example/x.png'],
    ['名前つき参照(コロン)', 'https&colon;//evil.example/x.png'],
    ['名前つき参照(TAB)', '&Tab;https://evil.example/x.png'],
    ['URL 途中の TAB', `htt${TAB}ps://evil.example/x.png`],
    ['URL 途中の LF', `htt${LF}ps://evil.example/x.png`],
    ['URL 途中の CR', `htt${CR}ps://evil.example/x.png`],
    ['前置きの制御文字', `${CR}${LF} https://evil.example/x.png`],
  ])('%s は外部参照として報告される', (_label, value) => {
    expect(findExternalRefsInTag('img', [{ name: 'src', value }])).toHaveLength(1);
  });

  it('正規化しても同梱資産への相対参照は通したまま(業務を止めない)', () => {
    expect(
      findExternalRefsInTag('link', [{ name: 'href', value: ` css/510&#48;37.css${LF}` }]),
    ).toEqual([]);
  });

  it('resolveServedAssetPath も同じ正規化を通す(実体の無い外部参照を解決しない)', () => {
    expect(resolveServedAssetPath('&#104;ttps://evil.example/x.css')).toBeUndefined();
    expect(resolveServedAssetPath(`css/510037.css${LF}`)).toBe('css/510037.css');
  });

  it('normalizeHtmlUrlValue は復号 → 除去 → trim の順で効く', () => {
    expect(normalizeHtmlUrlValue('&Tab;htt&#x70;s://x/y')).toBe('https://x/y');
  });
});

// ── srcdoc は URL ではなく HTML 文書 ──
// URL 属性として許可リストへ載せていた版は、中に書いた絶対参照を 1 件も報告しなかった
// (`<` 始まりの断片は必ず「相対参照」と判定される)。検査した気になるだけ悪い。
describe('iframe srcdoc は URL 属性として扱わない', () => {
  it('srcdoc は取得系 URL 属性の一覧に載らない', () => {
    expect(fetchUrlAttrsFor('iframe')).toEqual(['src']);
    expect(isFetchUrlAttr('iframe', 'srcdoc')).toBe(false);
  });

  it('入れ子 HTML 属性として宣言され、呼び出し側が再走査できる', () => {
    expect(nestedHtmlAttrsFor('iframe')).toEqual(['srcdoc']);
    expect(nestedHtmlAttrsFor('div')).toEqual([]);
  });

  it('iframe src 自体は従来どおり検査する', () => {
    expect(
      findExternalRefsInTag('iframe', [{ name: 'src', value: 'https://evil.example/' }]),
    ).toHaveLength(1);
  });
});

// ── 複数 URL を 1 属性へ詰める形 ──
// 分解しないと 2 個目以降が丸ごと検査から消える(実測: archive の 2 個目が 0 件だった)。
describe('複数 URL 属性は分解して全部見る', () => {
  it('object archive の 2 個目(空白区切り)も報告される', () => {
    const refs = findExternalRefsInTag('object', [
      { name: 'archive', value: 'a.jar https://evil.example/b.jar' },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toContain('evil.example');
  });

  it('object archive のカンマ区切りも分解する', () => {
    expect(
      findExternalRefsInTag('object', [
        { name: 'archive', value: 'a.jar,https://evil.example/b.jar' },
      ]),
    ).toHaveLength(1);
  });

  it('相対パスだけの archive は通す', () => {
    expect(findExternalRefsInTag('object', [{ name: 'archive', value: 'a.jar b.jar' }])).toEqual(
      [],
    );
  });
});

// ── 列挙漏れだった URL 属性(F35)──
// 属性の数え上げは必ず漏れる。漏れを塞ぐこと自体は必要だが、**強制点は egressGuard** で
// あることを忘れないこと(`htmlExternalRefs.ts` 冒頭)。ここは 400 で早期に返す層。
describe('列挙漏れだった取得系属性', () => {
  it.each([
    ['SVG script の href(SVG2)', 'script', 'href', 'https://evil.example/x.js'],
    ['SVG script の xlink:href(SVG1.1)', 'script', 'xlink:href', 'https://evil.example/x.js'],
    ['link rel=preload の imagesrcset', 'link', 'imagesrcset', 'https://evil.example/x.png 2x'],
  ])('%s は外部参照として報告される', (_label, tag, attr, value) => {
    expect(findExternalRefsInTag(tag, [{ name: attr, value }])).toHaveLength(1);
  });

  it('imagesrcset は複数 URL を分解する(2 個目が消えない)', () => {
    const refs = findExternalRefsInTag('link', [
      { name: 'imagesrcset', value: 'img/a.png 1x, https://evil.example/b.png 2x' },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toContain('evil.example');
  });

  it('相対パスだけの imagesrcset は通す', () => {
    expect(
      findExternalRefsInTag('link', [{ name: 'imagesrcset', value: 'img/a.png 1x, img/b.png 2x' }]),
    ).toEqual([]);
  });
});

// `<meta http-equiv=refresh content="0;url=…">` は URL 属性ではないので、
// `content` を許可リストへ載せる形では拾えない(載せると description 等が全部 URL 判定へ入る)。
describe('meta http-equiv=refresh の content', () => {
  it.each([
    ['url= 付き', '0;url=https://evil.example/'],
    ['url= 無し(仕様上ナビゲートする)', '0;https://evil.example/'],
    ['引用符つき', "0; url='https://evil.example/'"],
    ['空白と大小文字の揺れ', '  5 , URL = https://evil.example/  '],
  ])('%s は外部参照として報告される', (_label, content) => {
    const refs = findExternalRefsInTag('meta', [
      { name: 'http-equiv', value: 'refresh' },
      { name: 'content', value: content },
    ]);
    expect(refs).toHaveLength(1);
  });

  it('同一文書内への refresh は通す(遮断しすぎない)', () => {
    expect(
      findExternalRefsInTag('meta', [
        { name: 'http-equiv', value: 'Refresh' },
        { name: 'content', value: '30' },
      ]),
    ).toEqual([]);
  });

  it('refresh 以外の meta の content は URL 判定へ掛けない', () => {
    expect(
      findExternalRefsInTag('meta', [
        { name: 'name', value: 'description' },
        { name: 'content', value: 'https://example.com を参照' },
      ]),
    ).toEqual([]);
  });
});

// ── バックスラッシュの scheme 相対(F24)──
// WHATWG URL パーサは特殊スキームの base に対し `\` を `/` と同一視する。
describe('バックスラッシュで書いた scheme 相対', () => {
  it.each([
    '\\\\evil.example/x.png',
    '/\\evil.example/x.png',
    '\\/evil.example/x.png',
  ])('<img src="%s"> は外部参照として報告される', (value) => {
    expect(findExternalRefsInTag('img', [{ name: 'src', value }])).toHaveLength(1);
  });

  it('resolveServedAssetPath も同じ形を配信ルート配下へ解決しない', () => {
    expect(resolveServedAssetPath('\\\\evil.example/x.png')).toBeUndefined();
    expect(resolveServedAssetPath('/\\evil.example/x.png')).toBeUndefined();
  });
});
