// =============================================================================
// svgInspect.test.ts — 配信する SVG の許可リスト検査の固定
// =============================================================================
// 検査はサーバの 2 つの関所(配置・単体配信)が共有する唯一の判定なので、「通すべきものを通す」
// (Illustrator / Inkscape の通常出力)と同じ強さで「迂回入力を必ず落とす」を主張する。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectSvg } from '../src/security/svgInspect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(HERE, 'fixtures', 'svg', name), 'utf8');

const NS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';
const BOM = '﻿';
const wrap = (body: string): string => `<svg xmlns="${NS}" xmlns:xlink="${XLINK}">${body}</svg>`;

describe('inspectSvg — 通すもの', () => {
  it.each([
    'illustrator-export.svg',
    'illustrator-saveas-doctype.svg',
    'inkscape-plain.svg',
    'inkscape-svg-metadata.svg',
  ])('見本 %s は違反 0 件', (name) => {
    expect(inspectSvg(fixture(name))).toEqual([]);
  });

  it.each([
    ['最小形', `<svg xmlns="${NS}" width="10" height="10"><rect width="10" height="10"/></svg>`],
    ['XML 宣言 + コメント', `<?xml version="1.0" encoding="UTF-8"?><!-- c --><svg xmlns="${NS}"/>`],
    ['UTF-8 の BOM', `${BOM}<svg xmlns="${NS}"/>`],
    [
      '外部 ID だけの DOCTYPE',
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="${NS}"/>`,
    ],
    ['CDATA の style', wrap('<style><![CDATA[.a{fill:url(#g)}]]></style>')],
    [
      '埋め込みフォントの @font-face(data:font)',
      wrap(
        '<style><![CDATA[@font-face{font-family:"F";src:url(data:font/woff2;base64,AAAA) format("woff2")}]]></style>',
      ),
    ],
    ['use の #id', wrap('<use href="#a"/><use xlink:href="#a"/>')],
    ['fill の url(#id)', wrap('<rect fill="url(#grad)" filter="url(#f)"/>')],
    ['image の data:image/png', wrap('<image href="data:image/png;base64,iVBORw0KGgo="/>')],
    [
      'filter と fe*',
      wrap('<filter id="f"><feGaussianBlur stdDeviation="1"/><feOffset dx="1"/></filter>'),
    ],
    ['data-* 属性', wrap('<g data-part="logo"/>')],
    ['name 属性', wrap('<g name="qr"><rect width="1" height="1"/></g>')],
  ])('%s', (_label, svg) => {
    expect(inspectSvg(svg)).toEqual([]);
  });
});

describe('inspectSvg — 落とすもの', () => {
  it.each([
    'script',
    'foreignObject',
    'iframe',
    'object',
    'embed',
    'audio',
    'video',
    'a',
  ])('<%s> は禁止', (el) => {
    expect(inspectSvg(wrap(`<${el}/>`))).toContain(`禁止された要素 <${el}>`);
  });

  it.each([
    'animate',
    'set',
    'animateMotion',
    'animateTransform',
    'animateColor',
  ])('SMIL の <%s> は禁止', (el) => {
    expect(inspectSvg(wrap(`<rect><${el} attributeName="href" to="x"/></rect>`))).toContain(
      `禁止された要素 <${el}>`,
    );
  });

  it.each([
    ['onload 属性', `<svg xmlns="${NS}" onload="alert(1)"/>`, 'イベント属性 onload'],
    ['大文字の on 属性', wrap('<rect ONCLICK="x()"/>'), 'イベント属性 ONCLICK'],
    ['xml:base', wrap('<g xml:base="http://evil.example/"/>'), '許可されていない属性 xml:base'],
    [
      'svg: 接頭辞の script',
      `<svg xmlns="${NS}" xmlns:svg="${NS}"><svg:script>alert(1)</svg:script></svg>`,
      '許可されていない要素 <svg:script>',
    ],
    [
      'xlink の別名接頭辞',
      `<svg xmlns="${NS}" xmlns:q="${XLINK}"><use q:href="http://evil.example/x.svg#a"/></svg>`,
      '許可されていない名前空間宣言 xmlns:q',
    ],
    [
      'xlink の URI の差し替え',
      `<svg xmlns="${NS}" xmlns:xlink="http://evil.example/"/>`,
      '許可されていない名前空間宣言 xmlns:xlink',
    ],
    [
      '__proto__ という接頭辞(表引きで落ちない)',
      `<svg xmlns="${NS}" xmlns:__proto__="${XLINK}"/>`,
      '許可されていない名前空間宣言 xmlns:__proto__',
    ],
    [
      '既定名前空間の HTML への差し替え',
      wrap('<g xmlns="http://www.w3.org/1999/xhtml"/>'),
      '既定の名前空間が SVG ではない',
    ],
    ['未知の要素', wrap('<blink/>'), '許可されていない要素 <blink>'],
    ['未知の属性', wrap('<rect formaction="x"/>'), '許可されていない属性 formaction'],
    [
      'metadata の外の RDF',
      `<svg xmlns="${NS}" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:RDF/></svg>`,
      '許可されていない要素 <rdf:RDF>',
    ],
    [
      '内部サブセット',
      `<!DOCTYPE svg [ <!ATTLIST svg x CDATA "1"> ]><svg xmlns="${NS}"/>`,
      'DOCTYPE の内部サブセット',
    ],
    [
      'ENTITY 宣言',
      `<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="${NS}">&a;</svg>`,
      '<!ENTITY 宣言',
    ],
    [
      '文字参照で隠した javascript:',
      wrap('<use href="&#106;avascript:alert(1)"/>'),
      '外部を指す href(<use>)',
    ],
    [
      '16 進の文字参照で隠した javascript:',
      wrap('<image xlink:href="&#x6A;avascript:alert(1)"/>'),
      '外部を指す href(<image>)',
    ],
    ['外部ファイルの use', wrap('<use href="other.svg#a"/>'), '外部を指す href(<use>)'],
    [
      'プレゼンテーション属性の外部 url()',
      wrap('<rect fill="url(http://evil.example/x)"/>'),
      '外部参照を含む CSS(fill 属性)',
    ],
    [
      'プレゼンテーション属性の相対 url()',
      wrap('<rect filter="url(x.svg#f)"/>'),
      'url() が #id 以外を指す(filter 属性)',
    ],
    [
      'CSS エスケープで隠した外部 url()',
      wrap('<rect style="fill:url(\\68ttp://evil.example/x)"/>'),
      '外部参照を含む CSS(style 属性)',
    ],
    [
      'style 要素の @import',
      wrap('<style>@import url(x.css);</style>'),
      '外部参照を含む CSS(style 要素)',
    ],
    [
      'style 要素の相対 url()',
      wrap('<style><![CDATA[.a{fill:url(x.png)}]]></style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      'プレゼンテーション属性の data:image',
      wrap('<rect fill="url(data:image/png;base64,AAAA)"/>'),
      'url() が #id 以外を指す(fill 属性)',
    ],
    [
      'style 属性の data:image + #',
      wrap('<rect style="filter:url(data:image/png;base64,AAAA#f)"/>'),
      'url() が #id 以外を指す(style 属性)',
    ],
    [
      'style 属性の data:font/svg+xml',
      wrap('<rect style="fill:url(data:font/svg+xml,%3Csvg%3E#a)"/>'),
      'url() が #id 以外を指す(style 属性)',
    ],
    [
      'style 属性の data:image/png+xml',
      wrap('<rect style="fill:url(data:image/png+xml,x#a)"/>'),
      'url() が #id 以外を指す(style 属性)',
    ],
    [
      'style 属性の src:url(data:font)',
      wrap('<rect style="src:url(data:font/woff2;base64,AAAA)"/>'),
      'url() が #id 以外を指す(style 属性)',
    ],
    [
      '@font-face の data:font/svg',
      wrap('<style>@font-face{src:url(data:font/svg+xml,%3Csvg%3E)}</style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      '@font-face の data:font にフラグメント',
      wrap('<style>@font-face{src:url(data:font/woff2,AAAA#x)}</style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      '@font-face の外の data:font',
      wrap('<style>.a{background:url(data:font/woff2,AAAA)}</style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      '@font-face の src 以外の宣言',
      wrap('<style>@font-face{x:url(data:font/woff2,AAAA)}</style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      '閉じていない @font-face',
      wrap('<style>@font-face{src:url(data:font/woff2,AAAA)</style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      '@font-face を装う入れ子(@media の中)',
      wrap('<style>@media print{@font-face{src:url(data:font/woff2,AAAA)}}</style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      'style 要素の data:image/svg+xml',
      wrap('<style><![CDATA[.a{fill:url(data:image/svg+xml,%3Csvg%3E)}]]></style>'),
      'url() が #id 以外を指す(style 要素)',
    ],
    [
      'SVG の data URI',
      wrap('<image href="data:image/svg+xml,%3Csvg%3E"/>'),
      '外部を指す href(<image>)',
    ],
    [
      'UTF-8 以外の encoding 宣言',
      `<?xml version="1.0" encoding="Shift_JIS"?><svg xmlns="${NS}"/>`,
      'UTF-8 以外の encoding 宣言(Shift_JIS)',
    ],
    [
      'UTF-16 のバイト列を UTF-8 として読んだもの',
      Buffer.from(`${BOM}<svg xmlns="${NS}"/>`, 'utf16le').toString('utf8'),
      'NUL 文字を含む(UTF-16 などの可能性)',
    ],
    ['閉じていないタグ', `<svg xmlns="${NS}"><g>`, '閉じていないタグ <g>'],
    ['引用符の無い属性値', `<svg xmlns="${NS}" width=10/>`, '引用符の無い属性値 width'],
    [
      '先頭以外の処理命令',
      `<?xml-stylesheet href="x.css"?><svg xmlns="${NS}"/>`,
      '処理命令(先頭の <?xml ?> 以外)',
    ],
    ['ルートが svg でない', `<g xmlns="${NS}"/>`, 'ルート要素が svg ではない <g>'],
    ['未定義の実体参照', wrap('<text>&nbsp;</text>'), '定義されていない実体参照'],
  ])('%s', (_label, svg, message) => {
    expect(inspectSvg(svg)).toContain(message);
  });

  it('「編集機能を保持」で保存した Illustrator の SVG は落ちる', () => {
    expect(inspectSvg(fixture('illustrator-preserve-editing.svg'))).toContain('<!ENTITY 宣言');
  });

  it('同じ違反は 1 回だけ数える', () => {
    const found = inspectSvg(wrap('<script/><script/>'));
    expect(found.filter((m) => m === '禁止された要素 <script>')).toHaveLength(1);
  });
});

// `image-set("x.png" 1x)` のように引用符の文字列で URL を取る関数がある。関数名を数え上げずに
// 「URL にならない関数」の許可リストで判定するので、知らない関数は違反の側へ倒れる。
describe('inspectSvg — CSS の関数の中の引用符の文字列', () => {
  it.each([
    '<style>.a{background:image-set("x.png" 1x)}</style>',
    '<style>.a{background:-webkit-image-set("x.png" 1x)}</style>',
    '<rect style=\'fill:image-set("x.png" 1x)\'/>',
    '<style>.a{background:somefn("x.png")}</style>',
    '<style>.a{background:IMAGE-SET("x.png" 1x)}</style>',
    '<style>.a{background:\\69mage-set("x.png" 1x)}</style>',
    "<style>.a{background:image-set('x\\'.png' 1x)}</style>",
    '<style>.a{background:cross-fade("a.png" 50%, "b.png")}</style>',
    '<style>.a{background:image-set(var(--u, "x.png") 1x)}</style>',
    '<style>.a{background:image-set(env(u, "x.png") 1x)}</style>',
    '<style>.a{background:image-set(("x.png") 1x)}</style>',
    '<style>.a{src:src("x.png")}</style>',
    '<style>.a{--u:"x.png"}.b{background:image-set(var(--u) 1x)}</style>',
    '<style>.a{\\2d-u:"x.png"}</style>',
    '<style>@property --u{syntax:"*";inherits:false;initial-value:"x.png"}</style>',
    '<style>.a{background:image-set("data:image/png;base64,AAAA" 1x)}</style>',
    '<style>.a{fill:url("\u00a0#g")}</style>',
    '<style>.a{fill:url("\u3000#g")}</style>',
    '<style>.a{fill:url(\u00a0#g)}</style>',
    '<rect fill="url(#g\u3000)"/>',
    '<style>.a{fill:url("\ufeff#g")}</style>',
    '<style>.a{background:image-set("\u00a0#g" 1x)}</style>',
    '<style>.a{background:image-set("#g\u3000x.png" 1x)}</style>',
    '<style>.a{--u:{} "x.png"}</style>',
    '<style>.a{--u:{"x.png"}}</style>',
    `<rect style='--u:{} "x.png"'/>`,
    '<style>.a{background:image-set(attr(data-x, "x.png") 1x)}</style>',
  ])('関数の中の引用符の文字列が #id 以外を指せば違反 %s', (inner) => {
    expect(inspectSvg(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`)).not.toEqual([]);
  });

  it('違反の文言は場所を添える', () => {
    expect(inspectSvg(wrap('<style>.a{background:image-set("x.png" 1x)}</style>'))).toContain(
      '引用符の文字列が #id 以外を指す(style 要素)',
    );
    expect(inspectSvg(wrap('<rect style=\'fill:image-set("x.png" 1x)\'/>'))).toContain(
      '引用符の文字列が #id 以外を指す(style 属性)',
    );
  });

  it.each([
    '<style>.a{background:image-set("#g" 1x)}</style>',
    '<style>@font-face{font-family:"F";src:url(data:font/woff2;base64,AAAA) format("woff2")}</style>',
    '<style>.a{font-family:"Noto Sans"}</style>',
    '<style>.a::before{content:"注"}</style>',
    '<style>.a::before{content:counters(n, ".")}</style>',
    '<style>@font-face{font-family:"F";src:local("Noto Sans")}</style>',
    '<style>.a{fill:url("#g")}.b{fill:URL(#g)}</style>',
    '<style>.a{fill:url(" #g ")}.b{background:image-set(" #g " 1x)}</style>',
    '<style>.a{font-family:"x(";fill:url(#g)}.b::before{content:")"}</style>',
    '<style>/* image-set("x.png") */.a{fill:url(#g)}</style>',
    '<style>.a:not([class="x"]){fill:red}.b:is([id="y"]){fill:red}</style>',
    '<style>.a{background:image-set/**/("x.png" 1x)}</style>',
  ])('URL にならない文字列は違反にしない %s', (inner) => {
    expect(inspectSvg(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`)).toEqual([]);
  });
});

// CSS の前処理で CRLF は LF 1 個になるので、16 進エスケープの後ろの CRLF は 1 個の空白として
// 食われ、`\75` + CRLF + `rl(` は `url(` になる。style 属性では文字参照の CR LF が同じ形を作る。
describe('inspectSvg — CRLF をまたぐエスケープ', () => {
  it('style 要素の CRLF', () => {
    const css = `${String.raw`.a{fill:\75`}\r\nrl(http://evil.example/x)}`;
    expect(inspectSvg(wrap(`<style>${css}</style>`))).toContain('外部参照を含む CSS(style 要素)');
  });

  it('style 属性の文字参照 &#13;&#10;', () => {
    const attr = `${String.raw`fill:\75`}&#13;&#10;rl(http://evil.example/x)`;
    expect(inspectSvg(wrap(`<rect style="${attr}"/>`))).toContain('外部参照を含む CSS(style 属性)');
  });
});

// 悪意ある入力で同期処理を止めさせない(単体配信ルートはリクエスト毎に検査する)。実時間の上限は
// CI のランナーが遅い前提で緩く取る。二乗時間の経路が残ると桁違いに超える。
describe('inspectSvg — 入力サイズに対して線形', () => {
  const LIMIT_MS = 5000;
  const timed = (svg: string): number => {
    const t0 = performance.now();
    inspectSvg(svg);
    return performance.now() - t0;
  };

  it('名前の違う未知要素を大量に並べても終わる', () => {
    const body = Array.from({ length: 300_000 }, (_, i) => `<e${i}/>`).join('');
    expect(timed(wrap(body))).toBeLessThan(LIMIT_MS);
  });

  it('違反が多い入力は上限で打ち切って省略を報告する', () => {
    const body = Array.from({ length: 1000 }, (_, i) => `<e${i}/>`).join('');
    const found = inspectSvg(wrap(body));
    expect(found.length).toBeLessThanOrEqual(51);
    expect(found).toContain('違反が多いため以降は省略');
  });

  it('1 タグに属性を大量に付けても終わる', () => {
    const attrs = Array.from({ length: 300_000 }, (_, i) => `data-a${i}="1"`).join(' ');
    expect(timed(wrap(`<rect ${attrs}/>`))).toBeLessThan(LIMIT_MS);
  });

  it('DOCTYPE を大量に繰り返しても終わる', () => {
    const svg = `${'<!DOCTYPE svg>'.repeat(400_000)}<svg xmlns="${NS}"/>`;
    expect(timed(svg)).toBeLessThan(LIMIT_MS);
    expect(inspectSvg(svg)).toContain('DOCTYPE の位置が不正');
  });

  it('@font-face に長い空白と x:url() を大量に並べても終わる(約 1MB)', () => {
    const n = 60_000;
    const css = `@font-face{${' '.repeat(10 * n)}x:${'url(#a)'.repeat(n)}}`;
    const svg = wrap(`<style>${css}</style>`);
    expect(timed(svg)).toBeLessThan(LIMIT_MS);
    expect(inspectSvg(svg)).toEqual([]);
  });

  it('知らない属性は違反のまま', () => {
    expect(inspectSvg(wrap('<rect foo="1"/>'))).toContain('許可されていない属性 foo');
  });

  it('重複属性は違反のまま', () => {
    expect(inspectSvg(wrap('<rect width="1" width="2"/>'))).toContain('重複した属性 width');
  });
});

// `@namespace` の URI は取得されないので `#id` の検査から外す。形から外れたもの・ほかの文脈の
// URL は今までどおり違反。
describe('inspectSvg — @namespace', () => {
  it.each([
    '<style>@namespace svg url(http://www.w3.org/2000/svg);svg|rect{fill:red}</style>',
    '<style>@namespace "http://www.w3.org/2000/svg";.a{fill:url(#g)}</style>',
  ])('名前空間 URI は違反にしない %s', (inner) => {
    expect(inspectSvg(wrap(inner))).toEqual([]);
  });

  it.each([
    '<style>@namespace svg url(http://evil/x) .a{fill:red}</style>',
    '<style>@namespace "x" "http://evil/x";</style>',
    '<style>@media url(x.png){.a{fill:red}}</style>',
    '<style>@charset "http://evil/x";</style>',
    '<style>.a{@namespace url(http://evil/x);}</style>',
    '<style>@media print{@namespace url(http://evil/x);}</style>',
  ])('形から外れた・ほかの at-rule の URL は違反 %s', (inner) => {
    expect(inspectSvg(wrap(inner))).not.toEqual([]);
  });
});
