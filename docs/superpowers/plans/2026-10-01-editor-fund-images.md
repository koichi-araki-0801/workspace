# editor ファンド別画像（images/<fund>_<名前>）の表示 — 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部ツールが `dataRoot\images\` 直下に置いたファンド別画像（SVG / png / jpg）を、テンプレ・値入り HTML・ファンド CSS から相対パスで参照し、PDF・画面内プレビュー・編集画面で表示する。危険な SVG はどの経路でも配信・表示しない。

**Architecture:** `@editor/shared` に許可リスト型の字句走査 `inspectSvg` を 1 つ置き、サーバの 2 つの関所（`docAssets.stageDocAssets` の配置時と、新ルート `GET /api/fund-assets/images/:file` の単体配信時）で呼ぶ。配信の許可リストに深さ 0 の `images` グループを足し、プレビューホストのワイルドカードは `images/` を 404 にして画像の配信経路を新ルート 1 本に集める。画面内プレビューは親が新ルートから取得して data URI に埋め、編集画面は属性を書き換えず canvas 専用の `<style>` に `img[src="…"]{content:url(…)}` を書いて表示する。既存環境は `editor/patches/2026-10-fund-images/` のパッチで `.gitignore` と置き場を整える。

**Tech Stack:** TypeScript（Node 24 / Fastify / Vue 3 / GrapesJS 0.23.6 / vitest 4）、PowerShell 5.1（パッチ）、Pester 3/4（パッチのテスト）。

**Spec:** `docs/superpowers/specs/2026-10-01-editor-fund-images-design.md`

## Global Constraints

- 置き場は `config.imagesDir`（環境変数 `IMAGES_DIR`、appconfig `paths.imagesDir`、既定 `dataRoot/images`）。確定領域（`templates` `filled` `css` `sync`）の内側を指したら起動中止。
- 配信パスは `images/<ファイル名>`。拡張子は `.svg .png .jpg .jpeg`、深さ 0（直下だけ）、symlink 拒否。ファイル名の規則は機械検査しない。
- `.gitignore` の必須行に `/images/` を加える（`gitRepo.ts`・`init-data-repo.ps1`・パッチの 3 か所）。`COMMITTED_PATHSPECS` には入れない。
- SVG の検査は `inspectSvg(text: string): string[]`（空配列 = 合格）だけ。呼ぶのは配置時（`stageDocAssets`）と単体配信時（`fundAssets.routes.ts`）の 2 か所。違反は配置しない / 404。
- 共有の `ALLOWED_DATA_PREFIXES` は変えない（`data:image/svg+xml` を足さない）。`data:image/svg+xml` はプレビューの埋め込み処理が作るときだけ使う。
- 単体配信ルートの応答ヘッダは `Content-Type`（拡張子から）・`X-Content-Type-Options: nosniff`・`Cache-Control: no-store`、SVG だけ `Content-Security-Policy: sandbox`（独自コンテキストの `onSend` で付ける）。
- 編集画面は画像要素の属性を一切書き換えない。`toFilled` / `jinjaMask` / canvas 入口の刈り取り（`pruneCanvasActiveContent`）には手を入れない。
- web の配信 URL は `apiPaths.fundAssetImage` と `buildPath` から作る（`/api/fund-assets/images/:file`）。
- 日本語を含む `.ps1` は UTF-8 BOM。`.bat` は CRLF・`chcp 65001 >nul`・`.claude/rules/powershell.md` の 4 行雛形。パッチのテストは Pester 3/4 書式で、git の出力は ASCII の目印で照合する。
- コメント規約（`docs/コメント規約.md`）: なぜを書く。経緯・日付・所見番号は書かない。100 桁。新規 `.ts` は装飾ボックスの見出しを付ける。
- `editor/**` を変更したコミットの前に `pnpm exec biome check --write <変更ファイル>` を実行する。
- 新規の shared / server / web ファイルでテストしたものは、ルート `vitest.config.ts` の coverage include に追加し、単体で 85% を満たす。
- 型チェックは `pnpm typecheck:editor`（`@editor/shared` の先行ビルド込み）。shared を変えたら `pnpm --filter @editor/shared run build` を先に流す。
- コミットメッセージに署名行（Co-Authored-By / Claude-Session）を付けない。

## Review Focus

1. 文字編集の取り込み直し・ペーストの後も、保存出力（`getBodyHtml` → `toTemplate`）が原文の `src` のままで、配信 URL（`/api/fund-assets/…`）が 1 バイトも混ざらないこと。値入り本文の `{{ fund.code }}` 入り参照は解かずに警告になること（Task 6・Task 7 のテスト）。
2. ファンド CSS の `url(../images/x.svg)` から連鎖して参照された SVG も検査され、違反は置かれないこと。置いた SVG のバイト列が検査したバイト列そのものであること（Task 3 のテスト）。
3. 単体配信ルートで `..`・`%2F`・`%5C`・サブフォルダ・`CON.svg` などの予約名・許可外拡張子がすべて 404 になり、SVG の応答だけ helmet の全域 CSP が `sandbox` に置き換わること（Task 4 のテスト）。
4. `inspectSvg` が迂回入力（`xlink` の別名接頭辞、文字参照で隠した `javascript:`、CSS エスケープで隠した外部 `url()`、`xmlns:__proto__`、UTF-16 のバイト列）で違反を返し、Illustrator / Inkscape の通常出力の見本は通すこと（Task 1 のテスト）。
5. パッチが「`.gitignore` に `/images/` の 1 行が未コミットで足されただけ」の状態では進んでその差分をコミットし、それ以外の差分では止まること。rollback を 2 回流しても revert の revert にならないこと（Task 8 のテスト）。
6. 社内ツール（pdf-to-svg・pie-chart）の実出力 SVG が `inspectSvg` を通ること。落ちる場合も危険な構造は許可しないこと（Task 1b のテスト）。

---

### Task 1: shared に `inspectSvg` を作り、data URI の許可判定を述語で公開する

**Files:**
- Create: `editor/shared/src/security/svgInspect.ts`
- Create: `editor/shared/test/svgInspect.test.ts`
- Create: `editor/shared/test/fixtures/svg/illustrator-export.svg`、`illustrator-saveas-doctype.svg`、`inkscape-plain.svg`、`inkscape-svg-metadata.svg`、`illustrator-preserve-editing.svg`
- Modify: `editor/shared/src/security/cssExternalRefs.ts`（`ALLOWED_DATA_PREFIXES` の直後に述語を足し、`isSelfContainedUrl` の data 分岐をそれに寄せる）
- Modify: `editor/shared/test/cssExternalRefs.test.ts`（述語のテスト）
- Modify: `editor/shared/src/index.ts`（`security/htmlExternalRefs.js` の export の直後に 1 行）
- Modify: `vitest.config.ts`（coverage include の `'editor/shared/src/security/cssRebase.ts',` の直後）

**Interfaces:**
- Consumes: `collectCssUrlSpans(css)`・`findExternalRefsInCss(css)`（`cssExternalRefs.ts`）、`decodeHtmlEntities(value)`・`normalizeHtmlUrlValue(value)`（`htmlEntities.ts`）
- Produces: `export function isAllowedDataUrl(url: string): boolean`（`cssExternalRefs.ts`）、`export function inspectSvg(text: string): string[]`（`svgInspect.ts`。戻り値は違反の説明。空なら合格）

- [ ] **Step 1: 見本の SVG を置く**

`editor/shared/test/fixtures/svg/illustrator-export.svg`（Illustrator「書き出し → SVG 1.1」の通常出力の形）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 28.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" id="レイヤー_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px"
	 y="0px" width="200px" height="60px" viewBox="0 0 200 60" style="enable-background:new 0 0 200 60;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#1F5C99;}
	.st1{fill:url(#SVGID_1_);}
	.st2{font-family:'KozGoPr6N-Medium-90ms-RKSJ-H';}
	.st3{font-size:20px;}
</style>
<rect class="st0" width="60" height="60"/>
<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="70" y1="30" x2="190" y2="30">
	<stop  offset="0" style="stop-color:#1F5C99"/>
	<stop  offset="1" style="stop-color:#FFFFFF"/>
</linearGradient>
<path class="st1" d="M70,10h120v40H70V10z"/>
<text transform="matrix(1 0 0 1 72 38)" class="st2 st3">ロゴ</text>
</svg>
```

`illustrator-saveas-doctype.svg`（「別名で保存 → SVG 1.1」。外部 ID だけの DOCTYPE と、改行入りの埋め込み png）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 width="100px" height="40px" viewBox="0 0 100 40" enable-background="new 0 0 100 40" xml:space="preserve">
<g>
	<image overflow="visible" width="2" height="2" transform="matrix(20 0 0 20 0 0)" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI
mWP8z8DwnwEJMDEgAQBXfwJ/Y8qEOQAAAABJRU5ErkJggg==">
	</image>
	<polygon fill="#E60012" points="50,5 95,35 5,35 "/>
</g>
</svg>
```

`inkscape-plain.svg`（Inkscape 1.x「プレーン SVG」。`xmlns:svg` の宣言と filter を持つ）:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->

<svg
   width="60mm"
   height="20mm"
   viewBox="0 0 60 20"
   version="1.1"
   id="svg1"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg">
  <defs
     id="defs1">
    <filter
       style="color-interpolation-filters:sRGB"
       id="filter1"
       x="-0.1"
       y="-0.1"
       width="1.2"
       height="1.2">
      <feGaussianBlur
         stdDeviation="0.5"
         id="feGaussianBlur1" />
    </filter>
  </defs>
  <g
     id="layer1">
    <rect
       style="fill:#1f5c99;stroke-width:0.264583;filter:url(#filter1)"
       id="rect1"
       width="18"
       height="18"
       x="1"
       y="1" />
    <text
       xml:space="preserve"
       style="font-size:7px;font-family:'BIZ UDPGothic';fill:#20242c"
       x="22"
       y="13"
       id="text1"><tspan
         id="tspan1"
         x="22"
         y="13">ファンド</tspan></text>
  </g>
</svg>
```

`inkscape-svg-metadata.svg`（RDF メタデータ・`sodipodi:` / `inkscape:` の要素と属性・`xlink:href="#…"`）:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->

<svg
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   width="40"
   height="40"
   viewBox="0 0 40 40"
   version="1.1"
   id="svg8"
   inkscape:version="0.92.5 (2060ec1f9f, 2020-04-08)"
   sodipodi:docname="logo.svg">
  <defs id="defs2">
    <linearGradient id="linearGradient1" inkscape:collect="always">
      <stop style="stop-color:#1f5c99;stop-opacity:1" offset="0" id="stop1" />
      <stop style="stop-color:#ffffff;stop-opacity:1" offset="1" id="stop2" />
    </linearGradient>
    <linearGradient xlink:href="#linearGradient1" id="linearGradient2" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse" />
  </defs>
  <sodipodi:namedview id="base" pagecolor="#ffffff" bordercolor="#666666" inkscape:zoom="1" showgrid="false">
    <inkscape:grid type="xygrid" id="grid1" />
  </sodipodi:namedview>
  <metadata id="metadata5">
    <rdf:RDF>
      <cc:Work rdf:about="">
        <dc:format>image/svg+xml</dc:format>
        <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage" />
        <dc:title></dc:title>
      </cc:Work>
    </rdf:RDF>
  </metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <circle style="fill:url(#linearGradient2)" id="path1" cx="20" cy="20" r="18" />
    <use xlink:href="#path1" transform="translate(1,1)" id="use1" width="100%" height="100%" />
  </g>
</svg>
```

`illustrator-preserve-editing.svg`（「Illustrator の編集機能を保持」で保存した形。落ちるべきもの）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
	<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
]>
<svg version="1.1" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;"
	 xmlns="http://www.w3.org/2000/svg" width="10px" height="10px" viewBox="0 0 10 10">
<switch>
	<foreignObject requiredExtensions="&ns_ai;" x="0" y="0" width="1" height="1">
		<i:pgfRef  xlink:href="#adobe_illustrator_pgf">
		</i:pgfRef>
	</foreignObject>
	<g i:extraneous="self">
		<rect width="10" height="10"/>
	</g>
</switch>
<i:pgf  id="adobe_illustrator_pgf">
	<![CDATA[eJzt]]>
</i:pgf>
</svg>
```

手元に Illustrator / Inkscape があれば、同じ設定で書き出した実ファイルに差し替えてもよい（Step 4 のテストがそのまま通ること）。

- [ ] **Step 2: 失敗するテストを書く**

`editor/shared/test/svgInspect.test.ts`:

```ts
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
    ['UTF-8 の BOM', `﻿<svg xmlns="${NS}"/>`],
    [
      '外部 ID だけの DOCTYPE',
      `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="${NS}"/>`,
    ],
    ['CDATA の style', wrap('<style><![CDATA[.a{fill:url(#g)}]]></style>')],
    ['use の #id', wrap('<use href="#a"/><use xlink:href="#a"/>')],
    ['fill の url(#id)', wrap('<rect fill="url(#grad)" filter="url(#f)"/>')],
    ['image の data:image/png', wrap('<image href="data:image/png;base64,iVBORw0KGgo="/>')],
    ['filter と fe*', wrap('<filter id="f"><feGaussianBlur stdDeviation="1"/><feOffset dx="1"/></filter>')],
    ['data-* 属性', wrap('<g data-part="logo"/>')],
  ])('%s', (_label, svg) => {
    expect(inspectSvg(svg)).toEqual([]);
  });
});

describe('inspectSvg — 落とすもの', () => {
  it.each(['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'a'])(
    '<%s> は禁止',
    (el) => {
      expect(inspectSvg(wrap(`<${el}/>`))).toContain(`禁止された要素 <${el}>`);
    },
  );

  it.each(['animate', 'set', 'animateMotion', 'animateTransform', 'animateColor'])(
    'SMIL の <%s> は禁止',
    (el) => {
      expect(inspectSvg(wrap(`<rect><${el} attributeName="href" to="x"/></rect>`))).toContain(
        `禁止された要素 <${el}>`,
      );
    },
  );

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
    ['ENTITY 宣言', `<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="${NS}">&a;</svg>`, '<!ENTITY 宣言'],
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
    ['style 要素の @import', wrap('<style>@import url(x.css);</style>'), '外部参照を含む CSS(style 要素)'],
    [
      'style 要素の相対 url()',
      wrap('<style><![CDATA[.a{fill:url(x.png)}]]></style>'),
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
      Buffer.from(`﻿<svg xmlns="${NS}"/>`, 'utf16le').toString('utf8'),
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
```

`cssExternalRefs.test.ts` の import に `isAllowedDataUrl` を足し、ファイル末尾に追加:

```ts
describe('isAllowedDataUrl', () => {
  it('許可リストの data: URI だけを真にする(SVG は入れない)', () => {
    expect(isAllowedDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedDataUrl(' DATA:image/JPEG;base64,AAAA')).toBe(true);
    expect(isAllowedDataUrl('data:image/svg+xml,%3Csvg%3E')).toBe(false);
    expect(isAllowedDataUrl('data:text/html,x')).toBe(false);
    expect(isAllowedDataUrl('https://example.com/x.png')).toBe(false);
  });

  it('isSelfContainedUrl の data: 判定と一致する', () => {
    for (const url of ['data:image/png;base64,A', 'data:image/svg+xml,x', 'data:font/woff2;base64,A']) {
      expect(isSelfContainedUrl(url)).toBe(isAllowedDataUrl(url));
    }
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm --filter @editor/shared exec vitest run test/svgInspect.test.ts test/cssExternalRefs.test.ts`
Expected: FAIL（`Cannot find module '../src/security/svgInspect.js'`、`isAllowedDataUrl is not a function`）

- [ ] **Step 4: 実装する**

`cssExternalRefs.ts` の `ALLOWED_DATA_PREFIXES` の定義の直後に追加:

```ts
/**
 * `url` が許可リストの `data:` URI か。SVG の `<image href>` の判定(`svgInspect.ts`)が同じ
 * 許可リストを使うために公開する。リスト自体は公開しない — 呼び出し側で足し引きされると、
 * 「テンプレの著者が未検査の SVG を data URI で直接書ける」経路が開く。
 */
export function isAllowedDataUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith('data:') && ALLOWED_DATA_PREFIXES.some((p) => lower.startsWith(p));
}
```

`isSelfContainedUrl` の data 分岐を置き換える（判定は不変）:

```ts
  if (lower.startsWith('data:')) return isAllowedDataUrl(lower);
```

`editor/shared/src/security/svgInspect.ts`:

```ts
// =============================================================================
// svgInspect.ts — 配信する SVG を許可リストで検査する(字句走査・fail closed)
// =============================================================================
// ファンド別画像の SVG はエディタの外のツールが置き、PDF の headless ブラウザ・画面内プレビュー・
// 編集画面の 3 経路で表示される。SVG はスクリプト・イベント属性・外部参照・アニメーションによる
// 属性の書き換えを持ち込めるので、配る前に「知っている形だけ」を通す。
//
// DOM パーサに頼らない字句走査にしているのは、サーバ(Node。DOM が無い)とブラウザで同じ判定を
// 出すため。XML として解釈しきれない入力は違反にする(fail closed) — 我々の走査とブラウザの
// XML パーサの解釈がずれる余地を残さない。属性値は XML が定義する参照(数値文字参照と 5 種の
// 実体参照)だけを許し、それを解いた値で判定する。
//
// 許可集合は SVG 1.1 の要素・属性一覧から起こし、Illustrator「書き出し(SVG 1.1)」と
// Inkscape「プレーン SVG」の通常出力が通ることを `test/svgInspect.test.ts` の見本で固定する。
// 正当な画像が落ちたときは、サーバログの警告で違反名を見て、ここの集合へ足す。
//
// 呼ぶ場所は 2 つ(配置時 `server/src/vivliostyle/docAssets.ts`、単体配信
// `server/src/routes/fundAssets.routes.ts`)。画面内プレビューは後者から取得するので同じ関所を通る。

import { collectCssUrlSpans, findExternalRefsInCss, isAllowedDataUrl } from './cssExternalRefs.js';
import { decodeHtmlEntities, normalizeHtmlUrlValue } from './htmlEntities.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `xmlns:<接頭辞>` として宣言を許す接頭辞と URI(完全一致)。`Map` にしているのは、利用者入力の
 * 接頭辞で引くため(`__proto__` のような名前で `Object.prototype` を引かない)。
 * `svg` は Inkscape のプレーン SVG が冗長に宣言する。`svg:` 接頭辞の要素自体は通さない。
 */
const KNOWN_NAMESPACES: ReadonlyMap<string, readonly string[]> = new Map([
  ['svg', [SVG_NS]],
  ['xlink', ['http://www.w3.org/1999/xlink']],
  ['sodipodi', ['http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd']],
  ['inkscape', ['http://www.inkscape.org/namespaces/inkscape']],
  ['rdf', ['http://www.w3.org/1999/02/22-rdf-syntax-ns#']],
  ['dc', ['http://purl.org/dc/elements/1.1/']],
  ['cc', ['http://creativecommons.org/ns#', 'http://web.resource.org/cc/']],
]);

/** 編集ツールの付帯情報。描画にも実行にも関わらないので、要素・属性とも中身を問わず通す。 */
const EDITOR_PREFIXES: ReadonlySet<string> = new Set(['sodipodi', 'inkscape']);

/** RDF メタデータの接頭辞。`<metadata>` の内側でだけ要素として通す。 */
const METADATA_PREFIXES: ReadonlySet<string> = new Set(['rdf', 'dc', 'cc']);

/** 名前で拒む要素(許可外と分けて持つのは、違反の理由を名指しするため)。 */
const FORBIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'a',
  'animate',
  'set',
  'animateMotion',
  'animateTransform',
  'animateColor',
  'handler',
  'listener',
]);

/** SVG 1.1 の要素のうち通すもの(構造・図形・テキスト・塗り・クリップ・マスク・フィルタ)。 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'desc',
  'title',
  'metadata',
  'symbol',
  'use',
  'switch',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'pattern',
  'clipPath',
  'mask',
  'marker',
  'image',
  'style',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
]);

/** 値を CSS として検査する属性(SVG 1.1 のプレゼンテーション属性と、その後継の数個)。 */
const PRESENTATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  'alignment-baseline',
  'baseline-shift',
  'clip',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-profile',
  'color-rendering',
  'cursor',
  'direction',
  'display',
  'dominant-baseline',
  'enable-background',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'glyph-orientation-horizontal',
  'glyph-orientation-vertical',
  'image-rendering',
  'isolation',
  'kerning',
  'letter-spacing',
  'lighting-color',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'mix-blend-mode',
  'opacity',
  'overflow',
  'paint-order',
  'pointer-events',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-rendering',
  'transform-origin',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'word-spacing',
  'writing-mode',
]);

/** 値の形を問わない SVG 1.1 の属性(幾何・単位・フィルタの係数・条件処理など)。 */
const PLAIN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'class',
  'lang',
  'version',
  'baseProfile',
  'zoomAndPan',
  'x',
  'y',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'transform',
  'd',
  'points',
  'pathLength',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'offset',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'markerUnits',
  'markerWidth',
  'markerHeight',
  'refX',
  'refY',
  'orient',
  'filterUnits',
  'primitiveUnits',
  'filterRes',
  'in',
  'in2',
  'result',
  'mode',
  'type',
  'values',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'stdDeviation',
  'dx',
  'dy',
  'rotate',
  'textLength',
  'lengthAdjust',
  'startOffset',
  'method',
  'spacing',
  'requiredFeatures',
  'requiredExtensions',
  'systemLanguage',
  'externalResourcesRequired',
  'kernelMatrix',
  'kernelUnitLength',
  'divisor',
  'bias',
  'targetX',
  'targetY',
  'edgeMode',
  'preserveAlpha',
  'order',
  'surfaceScale',
  'diffuseConstant',
  'specularConstant',
  'specularExponent',
  'scale',
  'xChannelSelector',
  'yChannelSelector',
  'radius',
  'baseFrequency',
  'numOctaves',
  'seed',
  'stitchTiles',
  'tableValues',
  'slope',
  'intercept',
  'amplitude',
  'exponent',
  'azimuth',
  'elevation',
  'z',
  'pointsAtX',
  'pointsAtY',
  'pointsAtZ',
  'limitingConeAngle',
  'media',
  'title',
]);

/** `href` に `data:image/*`(共有の許可リスト内)を許す要素。それ以外の href は `#id` だけ。 */
const DATA_HREF_ELEMENTS: ReadonlySet<string> = new Set(['image', 'feImage']);

const NAME_RE = /[A-Za-z_][\w.:-]*/y;
const WS_RE = /\s/;
const XML_DECL_RE =
  /^\s+version\s*=\s*(["'])1\.\d+\1(?:\s+encoding\s*=\s*(["'])([A-Za-z][\w.-]*)\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\4)?\s*$/;
const DOCTYPE_RE =
  /^\s+svg(?:\s+PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')|\s+SYSTEM\s+(?:"[^"]*"|'[^']*'))?\s*$/;
/** XML が定義済みとする参照以外の `&`(未定義の実体参照・裸の `&`)。 */
const BAD_REFERENCE_RE = /&(?!(?:#\d+|#x[0-9a-fA-F]+|lt|gt|amp|quot|apos);)/;

interface SvgAttr {
  name: string;
  raw: string;
}

interface StartTag {
  name: string;
  attrs: SvgAttr[];
  selfClosing: boolean;
  end: number;
}

type Report = (message: string) => void;

/**
 * SVG 文書を検査し、違反の説明を返す(空配列 = 合格)。`text` は UTF-8 として読んだ文字列。
 * UTF-8 として読めないバイト列(U+FFFD)・NUL・UTF-8 以外の encoding 宣言は違反にする。
 */
export function inspectSvg(text: string): string[] {
  const found: string[] = [];
  const add: Report = (message) => {
    if (!found.includes(message)) found.push(message);
  };
  if (text.includes('\u0000')) add('NUL 文字を含む(UTF-16 などの可能性)');
  if (text.includes('�') || text.startsWith('￾')) add('UTF-8 として読めない');
  if (/<!ENTITY/i.test(text)) add('<!ENTITY 宣言');
  if (found.length > 0) return found;

  const stack: string[] = [];
  let pos = text.startsWith('﻿') ? 1 : 0;
  let sawRoot = false;
  let sawDoctype = false;
  let metadataDepth = 0;
  /** `<style>` の中にいる間だけ文字列(中身を CSS として集める)。外では null。 */
  let styleText: string | null = null;

  if (text.startsWith('<?xml', pos) && WS_RE.test(text.charAt(pos + 5))) {
    const end = text.indexOf('?>', pos);
    if (end < 0) {
      add('閉じていない XML 宣言');
      return found;
    }
    const decl = XML_DECL_RE.exec(text.slice(pos + 5, end));
    if (decl === null) add('解釈できない XML 宣言');
    else if (decl[3] !== undefined && decl[3].toLowerCase() !== 'utf-8') {
      add(`UTF-8 以外の encoding 宣言(${decl[3]})`);
    }
    pos = end + 2;
  }

  const takeText = (chunk: string): void => {
    if (BAD_REFERENCE_RE.test(chunk)) add('定義されていない実体参照');
    if (stack.length === 0) {
      if (chunk.trim() !== '') add('ルート要素の外の文字');
      return;
    }
    if (styleText !== null) styleText += decodeHtmlEntities(chunk);
  };

  const openElement = (tag: StartTag): void => {
    if (stack.length === 0) {
      if (sawRoot) add('ルート要素が 2 つ以上');
      if (tag.name !== 'svg') add(`ルート要素が svg ではない <${tag.name}>`);
      sawRoot = true;
    }
    if (styleText !== null) add('style 要素の中の要素');
    checkElement(tag.name, metadataDepth > 0, add);
    const foreign = tag.name.includes(':');
    for (const attr of tag.attrs) checkAttribute(tag.name, attr, foreign, add);
    if (tag.selfClosing) return;
    stack.push(tag.name);
    if (tag.name === 'metadata') metadataDepth++;
    if (tag.name === 'style') styleText = '';
  };

  const closeElement = (name: string): void => {
    if (name === 'metadata') metadataDepth--;
    if (name === 'style') {
      checkCss(styleText ?? '', 'style 要素', add);
      styleText = null;
    }
  };

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    takeText(text.slice(pos, lt < 0 ? text.length : lt));
    if (lt < 0) break;
    pos = lt;
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      if (end < 0) {
        add('閉じていないコメント');
        return found;
      }
      pos = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9);
      if (end < 0) {
        add('閉じていない CDATA');
        return found;
      }
      if (stack.length === 0) add('ルート要素の外の CDATA');
      if (styleText !== null) styleText += text.slice(pos + 9, end);
      pos = end + 3;
      continue;
    }
    if (text.startsWith('<!DOCTYPE', pos)) {
      const gt = text.indexOf('>', pos);
      if (gt < 0) {
        add('閉じていない DOCTYPE');
        return found;
      }
      const bracket = text.indexOf('[', pos);
      if (bracket >= 0 && bracket < gt) {
        add('DOCTYPE の内部サブセット');
        const close = text.indexOf(']>', bracket);
        if (close < 0) return found;
        pos = close + 2;
        continue;
      }
      if (sawRoot || sawDoctype) add('DOCTYPE の位置が不正');
      if (!DOCTYPE_RE.test(text.slice(pos + 9, gt))) add('外部 ID だけの DOCTYPE ではない');
      sawDoctype = true;
      pos = gt + 1;
      continue;
    }
    if (text.startsWith('<?', pos) || text.startsWith('<!', pos)) {
      add(text.startsWith('<?', pos) ? '処理命令(先頭の <?xml ?> 以外)' : '許可されていない宣言 <!…>');
      const gt = text.indexOf('>', pos);
      if (gt < 0) return found;
      pos = gt + 1;
      continue;
    }
    if (text.startsWith('</', pos)) {
      NAME_RE.lastIndex = pos + 2;
      const m = NAME_RE.exec(text);
      const gt = text.indexOf('>', pos);
      if (m === null || gt < 0 || text.slice(NAME_RE.lastIndex, gt).trim() !== '') {
        add('解釈できない終了タグ');
        return found;
      }
      const open = stack.pop();
      if (open !== m[0]) {
        add(`対応しない終了タグ </${m[0]}>`);
        return found;
      }
      closeElement(open);
      pos = gt + 1;
      continue;
    }
    const tag = readStartTag(text, pos);
    if (typeof tag === 'string') {
      add(tag);
      return found;
    }
    openElement(tag);
    pos = tag.end;
  }
  if (stack.length > 0) add(`閉じていないタグ <${stack[stack.length - 1]}>`);
  if (!sawRoot) add('svg 要素が無い');
  return found;
}

/** 開始タグを 1 つ読む。XML として読めない形は説明の文字列を返す(呼び出し側は走査を止める)。 */
function readStartTag(text: string, at: number): StartTag | string {
  NAME_RE.lastIndex = at + 1;
  const m = NAME_RE.exec(text);
  if (m === null) return '解釈できないタグ';
  const name = m[0];
  let p = NAME_RE.lastIndex;
  const attrs: SvgAttr[] = [];
  for (;;) {
    const before = p;
    while (p < text.length && WS_RE.test(text[p])) p++;
    if (p >= text.length) return `閉じていないタグ <${name}>`;
    if (text[p] === '>') return { name, attrs, selfClosing: false, end: p + 1 };
    if (text.startsWith('/>', p)) return { name, attrs, selfClosing: true, end: p + 2 };
    if (p === before) return `属性の前に空白が無い <${name}>`;
    NAME_RE.lastIndex = p;
    const an = NAME_RE.exec(text);
    if (an === null) return `解釈できない属性 <${name}>`;
    const attrName = an[0];
    p = NAME_RE.lastIndex;
    while (p < text.length && WS_RE.test(text[p])) p++;
    if (text[p] !== '=') return `値の無い属性 ${attrName}`;
    p++;
    while (p < text.length && WS_RE.test(text[p])) p++;
    const quote = text[p];
    if (quote !== '"' && quote !== "'") return `引用符の無い属性値 ${attrName}`;
    const close = text.indexOf(quote, p + 1);
    if (close < 0) return `閉じていない属性値 ${attrName}`;
    const raw = text.slice(p + 1, close);
    if (raw.includes('<')) return `属性値に < を含む ${attrName}`;
    if (attrs.some((a) => a.name === attrName)) return `重複した属性 ${attrName}`;
    attrs.push({ name: attrName, raw });
    p = close + 1;
  }
}

function checkElement(name: string, inMetadata: boolean, add: Report): void {
  const colon = name.indexOf(':');
  if (colon >= 0) {
    const prefix = name.slice(0, colon);
    if (EDITOR_PREFIXES.has(prefix) || (inMetadata && METADATA_PREFIXES.has(prefix))) return;
    add(`許可されていない要素 <${name}>`);
    return;
  }
  if (FORBIDDEN_ELEMENTS.has(name)) add(`禁止された要素 <${name}>`);
  else if (!ALLOWED_ELEMENTS.has(name)) add(`許可されていない要素 <${name}>`);
}

/**
 * 属性 1 つを検査する。`foreign` は編集ツール・RDF の要素で、接頭辞なしの属性は中身を問わない
 * (描画も実行もされない)。イベント属性・名前空間宣言・href はどの要素でも同じ規則で見る。
 */
function checkAttribute(el: string, attr: SvgAttr, foreign: boolean, add: Report): void {
  const { name, raw } = attr;
  if (BAD_REFERENCE_RE.test(raw)) add(`定義されていない実体参照(${name})`);
  const value = decodeHtmlEntities(raw);
  const colon = name.indexOf(':');
  const prefix = colon >= 0 ? name.slice(0, colon) : '';
  const local = colon >= 0 ? name.slice(colon + 1) : name;
  if (local.toLowerCase().startsWith('on')) {
    add(`イベント属性 ${name}`);
    return;
  }
  if (name === 'xmlns') {
    if (value !== SVG_NS) add('既定の名前空間が SVG ではない');
    return;
  }
  if (prefix === 'xmlns') {
    if (!(KNOWN_NAMESPACES.get(local) ?? []).includes(value)) {
      add(`許可されていない名前空間宣言 ${name}`);
    }
    return;
  }
  if (name === 'href' || name === 'xlink:href') {
    checkHref(el, raw, add);
    return;
  }
  if (prefix === 'xml') {
    if (local !== 'space' && local !== 'lang') add(`許可されていない属性 ${name}`);
    return;
  }
  if (prefix !== '') {
    if (name === 'xlink:title' || EDITOR_PREFIXES.has(prefix) || METADATA_PREFIXES.has(prefix)) {
      return;
    }
    add(`許可されていない属性 ${name}`);
    return;
  }
  if (name.startsWith('data-') || foreign) return;
  if (name === 'style' || PRESENTATION_ATTRIBUTES.has(name)) {
    checkCss(value, `${name} 属性`, add);
    return;
  }
  if (el === 'style' && name === 'type') {
    if (value.trim().toLowerCase() !== 'text/css') add('style 要素の type が text/css ではない');
    return;
  }
  if (!PLAIN_ATTRIBUTES.has(name)) add(`許可されていない属性 ${name}`);
}

/**
 * href は文書内の `#id` だけ。`<image>` / `<feImage>` に限り共有の許可リストの画像 data URI を
 * 許す。`raw` は復号前の値を渡す(`normalizeHtmlUrlValue` が 1 回だけ復号する。2 回解くと
 * `&amp;#35;x` が `#x` に化けて、ブラウザと違う値を判定してしまう)。
 */
function checkHref(el: string, raw: string, add: Report): void {
  const v = normalizeHtmlUrlValue(raw);
  if (v.startsWith('#')) return;
  if (DATA_HREF_ELEMENTS.has(el) && /^data:image\//i.test(v) && isAllowedDataUrl(v)) return;
  add(`外部を指す href(<${el}>)`);
}

/**
 * CSS(`<style>` の中身・`style` 属性・プレゼンテーション属性)の `url()` は `#id` だけ。
 * 外部参照の判定は検査・配置と同じトークナイザ(`findExternalRefsInCss`)に任せ、エスケープで
 * 隠した `url(\68ttp://…)` もそこで捕まえる。
 */
function checkCss(css: string, where: string, add: Report): void {
  if (findExternalRefsInCss(css).length > 0) add(`外部参照を含む CSS(${where})`);
  if (collectCssUrlSpans(css).some((span) => !span.value.trim().startsWith('#'))) {
    add(`url() が #id 以外を指す(${where})`);
  }
}
```

`editor/shared/src/index.ts` の `export * from './security/htmlExternalRefs.js';` の直後に追加:

```ts
// 配信する SVG の許可リスト検査。関所はサーバ(配置時と単体配信時)の 2 か所。
export * from './security/svgInspect.js';
```

`vitest.config.ts` の coverage include で `'editor/shared/src/security/cssRebase.ts',` の直後に追加:

```ts
        'editor/shared/src/security/svgInspect.ts',
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm --filter @editor/shared exec vitest run test/svgInspect.test.ts test/cssExternalRefs.test.ts`
Expected: PASS。見本が落ちたら、落ちた違反名を見て、見本ではなく許可集合の側を SVG 1.1 の一覧に照らして直す（見本は実際の出力の形なので書き換えない）。迂回入力が通ったら、判定を緩めた箇所を探して fail closed へ戻す。

- [ ] **Step 6: shared のビルドと既存テスト**

Run: `pnpm --filter @editor/shared run build && pnpm --filter @editor/shared exec vitest run`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/shared/src/security/svgInspect.ts editor/shared/src/security/cssExternalRefs.ts editor/shared/src/index.ts editor/shared/test/svgInspect.test.ts editor/shared/test/cssExternalRefs.test.ts
git add editor/shared/src/security/svgInspect.ts editor/shared/src/security/cssExternalRefs.ts editor/shared/src/index.ts editor/shared/test/svgInspect.test.ts editor/shared/test/cssExternalRefs.test.ts editor/shared/test/fixtures/svg vitest.config.ts
git commit -m "feat(shared): 配信する SVG を許可リストの字句走査で検査する inspectSvg を追加する"
```

---

### Task 1b: 実ツールの出力（pdf-to-svg・pie-chart）を `inspectSvg` の見本に加える

画像を作るのは社内ツールである。python-tools リポジトリの pdf-to-svg（PDF → SVG）と、このリポジトリの pie-chart（円グラフ SVG）の実際の出力が `inspectSvg` を必ず通ることを、見本ファイルで固定する。手で書いた見本（Task 1）だけでは、実ツールが出す要素・属性の取りこぼしに気付けない。

**Files:**
- Create: `editor/shared/test/fixtures/svg/tools/pie-chart/*.svg`（3 本）
- Create: `editor/shared/test/fixtures/svg/tools/pdf-to-svg/*.svg`（python-tools/pdf-to-svg の test/fixtures の PDF から変換したもの。最大 5 本）
- Create: `editor/shared/test/fixtures/svg/tools/README.md`（各ファイルの出所・生成コマンド・生成元のコミット SHA・作り直し方）
- Create: `editor/shared/test/svgInspect.tools.test.ts`
- Modify: `editor/shared/src/security/svgInspect.ts`（実出力が落ちた場合だけ、許可集合へ足す）

**Interfaces:**
- Consumes: `inspectSvg(text: string): string[]`（Task 1）
- Produces: なし（見本とテストのみ）

- [ ] **Step 1: pie-chart の出力を 3 本選んで置く**

`pie-chart/out/_baseline/` に出力があればそこから、無ければ `cd pie-chart && npm run batch` で `pie-chart/out/` に生成してから選ぶ。選ぶのは性質の違う 3 本: スライスの少ないもの（例 `asset_2slice_split.svg`）、多くラベルの混んだもの（例 `asset_11_mixed.svg`）、「その他」を含むもの（`ls pie-chart/out/_baseline | head -40` で名前を見て 1 本）。`editor/shared/test/fixtures/svg/tools/pie-chart/` へコピーする（中身は変えない）。

- [ ] **Step 2: pdf-to-svg の出力を作って置く**

`C:\Users\caads\python-tools\pdf-to-svg` の README と `src/` を読み、PDF を SVG に変換する処理をスクリプトから呼ぶ方法（CLI、または Python 関数を `py -3.13 -c` で呼ぶ）を特定する。GUI の起動を伴う経路は使わない。`test/fixtures/*.pdf`（`banner_sample.pdf` `clipped_image_sample.pdf` `ocr_layer_sample.pdf` `qr_cells_sample.pdf` など）を変換し、出力 SVG のうち 1 本 300KB 以下のものを最大 5 本、`editor/shared/test/fixtures/svg/tools/pdf-to-svg/` に置く（中身は変えない）。変換に使った一時フォルダは削除する。python-tools の作業ツリーは変更しない。変換方法がどうしても特定できない場合は BLOCKED で報告する（推測で手書きしない）。

- [ ] **Step 3: README を書く**

`editor/shared/test/fixtures/svg/tools/README.md` に、ファイルごとの出所（ツール名・入力・生成コマンド）、生成元のコミット SHA（`git -C C:\Users\caads\python-tools rev-parse --short HEAD`、pie-chart は workspace の HEAD）、ツールの出力が変わったら同じ手順で作り直して本テストを流すこと、を書く。

- [ ] **Step 4: 失敗するかもしれないテストを書く**

`editor/shared/test/svgInspect.tools.test.ts`:

```ts
// =============================================================================
// svgInspect.tools.test.ts — 社内ツールが実際に出す SVG が inspectSvg を通ることの固定
// =============================================================================
// 画像は pdf-to-svg と pie-chart が作って images/ に置く。検査が実出力を落とすと、正当な画像が
// 黙って表示されなくなる(配置しない・404)。見本は手で書かず、ツールの出力をそのまま置いている。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectSvg } from '../src/security/svgInspect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, 'fixtures', 'svg', 'tools');

const samples = ['pie-chart', 'pdf-to-svg'].flatMap((tool) =>
  readdirSync(path.join(TOOLS, tool))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => [`${tool}/${f}`, path.join(TOOLS, tool, f)] as const),
);

describe('社内ツールの実出力', () => {
  it('両ツールの見本が 1 本以上ある', () => {
    expect(samples.some(([n]) => n.startsWith('pie-chart/'))).toBe(true);
    expect(samples.some(([n]) => n.startsWith('pdf-to-svg/'))).toBe(true);
  });

  it.each(samples)('%s は違反なし', (_name, file) => {
    expect(inspectSvg(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
```

- [ ] **Step 5: テストを流す**

Run: `pnpm --filter @editor/shared exec vitest run test/svgInspect.tools.test.ts`
Expected: PASS。FAIL した場合は Step 6 へ。

- [ ] **Step 6: 落ちた場合は許可集合を足す（安全側を崩さない）**

違反の説明に出た要素・属性が、仕様 3.3 の「違反にするもの」（スクリプト・`foreignObject`・イベント属性・外部参照・別ファイル参照・`xml:base`・SMIL・未知の名前空間）に当たらない描画上の要素・属性であれば、`svgInspect.ts` の許可集合へ足し、`svgInspect.test.ts` にその要素・属性だけを使う最小の許可ケースを 1 件足す。違反にするものに当たる場合（例: pdf-to-svg が外部フォントを `@font-face src:url(http…)` で参照する）は許可せず、DONE_WITH_CONCERNS で内容を報告する（ツール側の出力を直すべきか、コントローラが判断する）。`data:font/…` の `@font-face` は共有の許可リストが既に許すので違反にならないはず。

Run: `pnpm --filter @editor/shared exec vitest run test/svgInspect.tools.test.ts test/svgInspect.test.ts`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
pnpm exec biome check --write editor/shared/test/svgInspect.tools.test.ts editor/shared/src/security/svgInspect.ts
git add editor/shared/test/fixtures/svg/tools editor/shared/test/svgInspect.tools.test.ts editor/shared/src/security/svgInspect.ts editor/shared/test/svgInspect.test.ts
git commit -m "test(shared): pdf-to-svg と pie-chart の実出力 SVG が inspectSvg を通ることを見本で固定する"
```

---

### Task 2: config に `imagesDir` を足し、確定領域の内側なら起動を止める。`.gitignore` と init-data-repo に images を加える

**Files:**
- Create: `editor/server/src/git/committedAreas.ts`
- Modify: `editor/server/src/git/gitRepo.ts`（`COMMITTED_PATHSPECS` 283 行付近、`ensureGitignore` の `required` 216 行付近）
- Modify: `editor/server/src/config.ts`（スキーマ `paths` 48-64 行、置き場 `jsDir` の直後、末尾の `assertNoLegacyAssetsDir(...)` 呼び出しの直後）
- Modify: `editor/server/test/config.paths.test.ts`
- Modify: `editor/server/test/gitRepo.test.ts`（`/css/fonts/` を確かめているテストの直後）
- Modify: `editor/scripts/init-data-repo.ps1`（DESCRIPTION の 1.、`$dirs`、`.gitignore` の中身）
- Modify: `vitest.config.ts`（coverage include の `'editor/server/src/git/gitRepo.ts',` の直後）

**Interfaces:**
- Produces: `export const COMMITTED_AREAS: readonly ['templates', 'filled', 'css', 'sync']`（`git/committedAreas.ts`）、`config.imagesDir: string`（既定 `dataRoot/images`）、`export function assertImagesDirOutsideCommittedAreas(opts: { imagesDir: string; gitRepoDir: string; areas?: readonly string[] }): void`（`config.ts`）、`.gitignore` 必須行 `['/drafts/', '/reviews/', '/pending/', '/notes/', '/css/fonts/', '/images/', '*.tmp-*']`

- [ ] **Step 1: 失敗するテストを書く**

`config.paths.test.ts` の `PATH_ENV_KEYS` の `'JS_DIR',` の直後に `'IMAGES_DIR',` を足す。`derives every data directory from DATA_ROOT` の `expect(config.jsDir)…` の直後に足す:

```ts
    expect(config.imagesDir).toBe(path.join(DATA_ROOT, 'images'));
```

`describe('config paths', …)` の末尾（`ASSETS_DIR が残っていたら…` の直後）に追加:

```ts
  it('IMAGES_DIR が imagesDir を上書きする', async () => {
    const imagesDir = path.resolve(path.sep, 'tmp', 'editor-images-elsewhere');
    const { config } = await importConfigWithEnv({ DATA_ROOT, IMAGES_DIR: imagesDir });
    expect(config.imagesDir).toBe(imagesDir);
  });

  it('IMAGES_DIR が確定領域(css)の内側なら起動を中止する', async () => {
    await expect(
      importConfigWithEnv({ DATA_ROOT, IMAGES_DIR: path.join(DATA_ROOT, 'css', 'images') }),
    ).rejects.toThrow(/imagesDir.*css/s);
  });
```

ファイル末尾に追加:

```ts
describe('assertImagesDirOutsideCommittedAreas', () => {
  it.each(['templates', 'filled', 'css', 'sync'])(
    '%s の内側と、その領域そのものを拒む',
    async (area) => {
      const { assertImagesDirOutsideCommittedAreas } = await importConfigWithEnv({ DATA_ROOT });
      for (const imagesDir of [path.join(DATA_ROOT, area, 'images'), path.join(DATA_ROOT, area)]) {
        expect(() =>
          assertImagesDirOutsideCommittedAreas({ imagesDir, gitRepoDir: DATA_ROOT }),
        ).toThrow(new RegExp(area));
      }
    },
  );

  it('dataRoot 直下の images と、名前が前方一致するだけの兄弟は通す', async () => {
    const { assertImagesDirOutsideCommittedAreas } = await importConfigWithEnv({ DATA_ROOT });
    for (const imagesDir of [path.join(DATA_ROOT, 'images'), path.join(DATA_ROOT, 'css-images')]) {
      expect(() =>
        assertImagesDirOutsideCommittedAreas({ imagesDir, gitRepoDir: DATA_ROOT }),
      ).not.toThrow();
    }
  });
});
```

`gitRepo.test.ts` の `expect(…).toContain('/css/fonts/');` の直後に追加:

```ts
    expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8').split('\n')).toContain('/images/');
```

同じ `it` の直後に追加:

```ts
  it('commitAll は images/ を巻き込まない', async () => {
    fs.mkdirSync(path.join(tmp, 'images'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'images', '510037_logo.svg'), '<svg/>', 'utf8');
    const rel = 'templates/AM01_999999_20250107_交付版.html';
    fs.writeFileSync(path.join(tmp, rel), '<p>images 除外</p>', 'utf8');

    const hash = await git.commitAll('確定保存: images 除外', { name: 'tester' });
    const files = await git.commitFiles(hash);
    expect(files).toContain(rel);
    expect(files.some((f) => f.startsWith('images/'))).toBe(false);
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/config.paths.test.ts test/gitRepo.test.ts`
Expected: FAIL（`config.imagesDir` が undefined、`assertImagesDirOutsideCommittedAreas` が無い、`.gitignore` に `/images/` が無い）

- [ ] **Step 3: 実装する**

`editor/server/src/git/committedAreas.ts`:

```ts
// =============================================================================
// committedAreas.ts — 承認コミットが記録する dataRoot 直下の領域(確定領域)の正典
// =============================================================================
// `gitRepo.ts` の stage 対象と、`config.ts` の「置き場が確定領域の内側に入っていないか」の
// 起動時検査が同じ一覧を見る。config は gitRepo を import できない(gitRepo が config を読む)
// ので、依存の無いここへ切り出して両方から引く。片方だけ書き換わると、検査が見ていない
// 領域へ置いた画像が承認コミットへ巻き込まれる。

/** 承認コミットで `git add -A -- <領域>` する dataRoot 直下のディレクトリ。 */
export const COMMITTED_AREAS = ['templates', 'filled', 'css', 'sync'] as const;
```

`gitRepo.ts` の import に `import { COMMITTED_AREAS } from './committedAreas.js';` を足し、`COMMITTED_PATHSPECS` を置き換える:

```ts
const COMMITTED_PATHSPECS = [...COMMITTED_AREAS, '.gitignore', '.gitattributes'];
```

`ensureGitignore` の `required` を置き換え、直前のコメントに 1 段落足す:

```ts
  // `/images/` は別ツールが置くファンド別画像。エディタは読むだけで版を記録しない(過去版の
  // 表示も現在の画像を使う)。追跡すると次の承認者の名前で画像が承認コミットへ混ざる。
  const required = [
    '/drafts/',
    '/reviews/',
    '/pending/',
    '/notes/',
    '/css/fonts/',
    '/images/',
    '*.tmp-*',
  ];
```

`config.ts` の import に `import { COMMITTED_AREAS } from './git/committedAreas.js';` を足す。スキーマ `paths` の `jsDir: z.string().optional(),` の直後に追加:

```ts
        imagesDir: z.string().optional(),
```

`config` の `jsDir: resolveDataPath(…),` の直後に追加:

```ts
  /**
   * ファンド別画像(`images/<fund>_<名前>.<拡張子>`)の置き場。別ツールが置き、エディタは読んで
   * 表示するだけ。git 管理外(`.gitignore` の `/images/`)。テンプレ・値入り HTML・ファンド CSS は
   * `images/…`(CSS からは `../images/…`)の相対パスで参照し、PDF の配信ルートへは
   * `vivliostyle/docAssets.ts` が参照されたものだけを写す。画面内プレビューと編集画面は
   * `GET /api/fund-assets/images/:file` から取る。
   *
   * ⚠ 確定領域(`git/committedAreas.ts`)の内側は不可(起動時に止める)。
   */
  imagesDir: resolveDataPath(process.env.IMAGES_DIR, file.paths?.imagesDir, 'images'),
```

`assertNoLegacyAssetsDir` の定義の直後に追加:

```ts
/**
 * `imagesDir` が確定領域(承認コミットが `git add -A -- <領域>` する dataRoot 直下の
 * ディレクトリ)の内側にないか。内側だと、別ツールが置いた画像が次の承認で承認者の名前の
 * コミットへ巻き込まれる(`.gitignore` の `/images/` は dataRoot 直下にしか効かない)。
 */
export function assertImagesDirOutsideCommittedAreas(opts: {
  imagesDir: string;
  gitRepoDir: string;
  areas?: readonly string[];
}): void {
  const target = path.resolve(opts.imagesDir);
  for (const area of opts.areas ?? COMMITTED_AREAS) {
    const rel = path.relative(path.resolve(opts.gitRepoDir, area), target);
    const inside = rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
    if (!inside) continue;
    throw new Error(
      `[config] imagesDir(${opts.imagesDir})が承認コミットの対象 ${area}/ の内側にあります。` +
        ' 画像が承認コミットへ巻き込まれるため起動を中止しました。' +
        ' 環境変数 IMAGES_DIR / appconfig の paths.imagesDir を dataRoot\\images などへ移してください。',
    );
  }
}
```

ファイル末尾の `assertNoLegacyAssetsDir({ … });` の直後に追加:

```ts
assertImagesDirOutsideCommittedAreas({ imagesDir: config.imagesDir, gitRepoDir: config.gitRepoDir });
```

`init-data-repo.ps1`（UTF-8 BOM を保つ。Edit で書き換える）:

DESCRIPTION の 1. の 2 行を置き換える:

```powershell
    1. dataRoot 配下にサーバが使う置き場をすべて作成する(templates/ filled/ css/ css/fonts/ sync/
       drafts/ pending/ reviews/ notes/ js/ images/)。サーバも必要時に作るが、
```

`$dirs` を置き換える:

```powershell
$dirs = 'templates', 'filled', 'css', 'css\fonts', 'sync', 'drafts', 'pending', 'reviews', 'notes',
  'js', 'images'
```

`.gitignore` の書き込みを置き換える:

```powershell
    [IO.File]::WriteAllText((Join-Path $DataRoot '.gitignore'),
      "/drafts/`n/reviews/`n/pending/`n/notes/`n/css/fonts/`n/images/`n*.tmp-*`n", $utf8NoBom)
```

`vitest.config.ts` の coverage include で `'editor/server/src/git/gitRepo.ts',` の直後に追加:

```ts
        'editor/server/src/git/committedAreas.ts',
```

- [ ] **Step 4: テストと実行確認**

Run: `pnpm --filter server exec vitest run test/config.paths.test.ts test/gitRepo.test.ts`
Expected: PASS

Run（PowerShell）: `$t = Join-Path $env:TEMP ("idr-" + [guid]::NewGuid().ToString('N').Substring(0,8)); cmd /c "editor\scripts\init-data-repo.bat -DataRoot $t 2>nul"; Get-ChildItem $t -Name; Get-Content (Join-Path $t .gitignore); Remove-Item -Recurse -Force $t -Confirm:$false`
Expected: `images` があり、`.gitignore` に `/images/`。

Run: `head -c 3 editor/scripts/init-data-repo.ps1 | od -An -tx1`
Expected: `ef bb bf`

Run: `pnpm typecheck:editor`
Expected: エラー 0

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/git/committedAreas.ts editor/server/src/git/gitRepo.ts editor/server/src/config.ts editor/server/test/config.paths.test.ts editor/server/test/gitRepo.test.ts
git add editor/server/src/git/committedAreas.ts editor/server/src/git/gitRepo.ts editor/server/src/config.ts editor/server/test/config.paths.test.ts editor/server/test/gitRepo.test.ts editor/scripts/init-data-repo.ps1 vitest.config.ts
git commit -m "feat(editor): ファンド別画像の置き場 imagesDir を追加し、確定領域の内側なら起動を止めて .gitignore の対象にする"
```

---

### Task 3: 配信の許可リストに images グループを足し、配置時に SVG を検査する

**Files:**
- Modify: `editor/server/src/vivliostyle/docAssets.ts`（冒頭コメント 12-21 行、`AssetGroup` 31-43 行、`MAX_ASSET_DEPTH` 104-108 行を `ASSET_GROUPS` より前へ移す、`ASSET_GROUPS` 63-82 行、`collectGroup` 146 行、`resolveServedAssetSource` 193 行、`stageDocAssets` 285-307 行）
- Modify: `editor/server/test/docAssets.test.ts`

**Interfaces:**
- Consumes: `inspectSvg`（Task 1）、`config.imagesDir`（Task 2）、`logger`（`../logger.js`）
- Produces: `export const FUND_IMAGES_MOUNT = 'images'`、`export function isFundImagePath(rel: string): boolean`、配信パス `images/<file>.{svg,png,jpg,jpeg}`（直下だけ）。`resolveServedAssetSource(rel)` と `stageDocAssets(dir, opts)` のシグネチャは不変。

- [ ] **Step 1: 失敗するテストを書く**

`docAssets.test.ts` の置き場変数に `imagesDir` を足し、ロガーの差し替えを用意する:

```ts
let root: string;
let cssDir: string;
let jsDir: string;
let imagesDir: string;
let dest: string;
/** `stageDocAssets` が出す警告(違反 SVG)の受け口。 */
const warn = vi.fn();
```

`loadStage` と `loadResolve` の `vi.doMock('../src/config.js', …)` の `config: { cssDir, jsDir }` を 2 か所とも `config: { cssDir, jsDir, imagesDir }` にし、それぞれの `vi.doMock('../src/config.js', …)` の直後に追加:

```ts
  vi.doMock('../src/logger.js', () => ({ logger: { warn } }));
```

`beforeEach` に `imagesDir = path.join(root, 'data', 'images');` と `warn.mockReset();` を足し、`afterEach` に `vi.doUnmock('../src/logger.js');` を足す。ファイル末尾に追加:

```ts
const NS = 'http://www.w3.org/2000/svg';
const GOOD_SVG = `<svg xmlns="${NS}" width="10" height="10"><rect width="10" height="10"/></svg>`;
const BAD_SVG = `<svg xmlns="${NS}" onload="alert(1)"><rect width="10" height="10"/></svg>`;

// ── ファンド別画像(images/)──
// 置き場は別ツールが書くフラットなフォルダ。参照されたものだけ・直下だけ・許可拡張子だけを
// 置き、SVG は中身を検査して違反を置かない(参照は表示されないまま落ちる)。
describe('stageDocAssets — ファンド別画像(images/)', () => {
  it('images 直下の参照された画像だけを置く(他ファンドの画像は載らない)', async () => {
    await write(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
    await write(path.join(imagesDir, '510037_photo.png'), 'png');
    await write(path.join(imagesDir, '510155_logo.svg'), GOOD_SVG);
    const served = await (await loadStage())(dest, {
      referenced: new Set(['images/510037_logo.svg', 'images/510037_photo.png']),
    });
    expect([...served].sort()).toEqual(['images/510037_logo.svg', 'images/510037_photo.png']);
  });

  it('サブフォルダと許可外の拡張子は置かない', async () => {
    await write(path.join(imagesDir, 'sub', '510037_a.svg'), GOOD_SVG);
    await write(path.join(imagesDir, '510037_a.gif'), 'gif');
    const served = await (await loadStage())(dest, {
      referenced: new Set(['images/sub/510037_a.svg', 'images/510037_a.gif']),
    });
    expect(served.size).toBe(0);
  });

  it('違反した SVG は置かずに警告する', async () => {
    await write(path.join(imagesDir, '510037_bad.svg'), BAD_SVG);
    const served = await (await loadStage())(dest, {
      referenced: new Set(['images/510037_bad.svg']),
    });
    expect(served.size).toBe(0);
    await expect(fs.stat(path.join(dest, 'images', '510037_bad.svg'))).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'images/510037_bad.svg' }),
      expect.any(String),
    );
  });

  it('参照されていない SVG は読まない(違反があっても警告しない)', async () => {
    await write(path.join(imagesDir, '510037_bad.svg'), BAD_SVG);
    await write(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
    await (await loadStage())(dest, { referenced: new Set(['images/510037_logo.svg']) });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ファンド CSS の url(../images/…) から連鎖した SVG も検査する', async () => {
    await write(
      path.join(cssDir, '510037.css'),
      '.a{background:url(../images/510037_bad.svg)} .b{background:url(../images/510037_logo.svg)}',
    );
    await write(path.join(imagesDir, '510037_bad.svg'), BAD_SVG);
    await write(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
    const served = await (await loadStage())(dest, { referenced: new Set(['css/510037.css']) });
    expect([...served].sort()).toEqual(['css/510037.css', 'images/510037_logo.svg']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('置いた SVG のバイト列は検査したものと同じ', async () => {
    await write(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
    await (await loadStage())(dest, { referenced: new Set(['images/510037_logo.svg']) });
    expect(await fs.readFile(path.join(dest, 'images', '510037_logo.svg'), 'utf8')).toBe(GOOD_SVG);
  });

  it('referenced 省略(全件)でも違反 SVG は置かない', async () => {
    await write(path.join(imagesDir, '510037_bad.svg'), BAD_SVG);
    await write(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
    const served = await (await loadStage())(dest);
    expect([...served]).toEqual(['images/510037_logo.svg']);
  });
});

describe('resolveServedAssetSource / isFundImagePath — images/', () => {
  it('images 直下だけを引き、サブフォルダ・許可外拡張子は引かない', async () => {
    await write(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
    await write(path.join(imagesDir, 'sub', '510037_deep.svg'), GOOD_SVG);
    await write(path.join(imagesDir, '510037_anim.gif'), 'gif');
    const resolve = await loadResolve();
    expect(await resolve('images/510037_logo.svg')).toBe(path.join(imagesDir, '510037_logo.svg'));
    expect(await resolve('images/sub/510037_deep.svg')).toBeUndefined();
    expect(await resolve('images/510037_anim.gif')).toBeUndefined();
  });

  it('既存グループの深さは変わらない(css/fonts の 2 段下は引ける)', async () => {
    await write(path.join(cssDir, 'fonts', 'noto', 'JP', 'a.woff2'), 'font');
    const resolve = await loadResolve();
    expect(await resolve('css/fonts/noto/JP/a.woff2')).toBe(
      path.join(cssDir, 'fonts', 'noto', 'JP', 'a.woff2'),
    );
  });

  it('isFundImagePath は images/ 始まり(大小文字を問わない)だけを真にする', async () => {
    await loadResolve();
    const { isFundImagePath } = await import('../src/vivliostyle/docAssets.js');
    expect(isFundImagePath('images/510037_logo.svg')).toBe(true);
    expect(isFundImagePath('Images/510037_logo.svg')).toBe(true);
    expect(isFundImagePath('css/510037.css')).toBe(false);
    expect(isFundImagePath('imagesx/a.svg')).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/docAssets.test.ts`
Expected: FAIL（images グループが無い・`isFundImagePath` が無い）

- [ ] **Step 3: 実装する**

`docAssets.ts` の import に追加:

```ts
import { collectCssUrlCandidates, inspectSvg } from '@editor/shared';
import { logger } from '../logger.js';
```

冒頭コメントの「決められた 3 つの置き場」を「決められた 4 つの置き場」にし、「置き場」節を置き換える:

```ts
// ── 置き場(利用者決定・変更しないこと) ──
//   css       = `config.cssDir`        (per-fund。`<fund>.css`。直下の `fonts/` は下の別グループ)
//   css/fonts = `config.cssDir/fonts`  (全ファンド共通のフォント。CSS から `url(fonts/…)`)
//   js        = `config.jsDir`         (全ファンド共通のテンプレ JS)
//   images    = `config.imagesDir`     (ファンド別画像。直下だけ。SVG は置く前に `inspectSvg`)
// 配信ルートでの名前は `css/` `css/fonts/` `js/` `images/` に固定する(テンプレ側の相対参照と対)。
```

`AssetGroup` に深さの上限を足す:

```ts
  /**
   * 置き場から降りる深さの上限(0 = 直下のファイルだけ)。走査(`collectGroup`)と 1 本配る解決
   * (`resolveServedAssetSource`)が同じ値を見る — 片方だけ深く見ると、配置されないのに単体配信
   * される形の食い違いが生まれる。
   */
  readonly maxDepth: number;
```

`MAX_ASSET_DEPTH` の定義（doc コメントごと）を `FONT_EXTENSIONS` の直前へ移す（`ASSET_GROUPS` の初期化が参照するため、後ろに置くと TDZ で import 時に落ちる）。`ASSET_GROUPS` を置き換える:

```ts
const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.ttf', '.otf', '.woff', '.woff2']);

/** ファンド別画像として配る拡張子。web の `lib/fundImages.ts` の MIME 表と揃える。 */
const FUND_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.svg', '.png', '.jpg', '.jpeg']);

/** 配信ルートでのファンド別画像の置き場(テンプレの相対参照 `images/…` の先頭)。 */
export const FUND_IMAGES_MOUNT = 'images';

const ASSET_GROUPS: readonly AssetGroup[] = [
  {
    mount: 'css/fonts',
    sourceDir: () => path.join(config.cssDir, 'fonts'),
    extensions: FONT_EXTENSIONS,
    maxDepth: MAX_ASSET_DEPTH,
  },
  {
    mount: 'css',
    sourceDir: () => config.cssDir,
    extensions: new Set(['.css']),
    skipTopDirs: new Set(['fonts']),
    maxDepth: MAX_ASSET_DEPTH,
  },
  {
    mount: 'js',
    sourceDir: () => config.jsDir,
    extensions: new Set(['.js', '.mjs']),
    maxDepth: MAX_ASSET_DEPTH,
  },
  {
    mount: FUND_IMAGES_MOUNT,
    sourceDir: () => config.imagesDir,
    extensions: FUND_IMAGE_EXTENSIONS,
    // 直下だけ。ファンドの区別は命名の約束(`<fund>_<名前>`)で持ち、サブフォルダは作らない契約。
    maxDepth: 0,
  },
];

/**
 * 配信ルート相対パスがファンド別画像の置き場を指すか。大小文字を問わないのは、Windows の
 * 置き場では `Images/x.svg` も同じ実体に届くため(配信面を絞る側の判定は広く取る)。
 */
export function isFundImagePath(rel: string): boolean {
  return rel.split('/')[0].toLowerCase() === FUND_IMAGES_MOUNT;
}
```

`collectGroup` の `if (depth > MAX_ASSET_DEPTH) return;` を `if (depth > group.maxDepth) return;` に、`resolveServedAssetSource` の `if (rest.length > MAX_ASSET_DEPTH + 1) return undefined;` を `if (rest.length > group.maxDepth + 1) return undefined;` に置き換える。

`stageDocAssets` の直前に追加:

```ts
/**
 * SVG を読んで検査し、合格ならそのバイト列を返す。違反・読めないときは `undefined`。
 * 呼び出し側は**このバイト列を書く**(検査後に読み直すと、その間の差し替えを検査せずに通す)。
 */
async function readInspectedSvg(file: AssetFile): Promise<Buffer | undefined> {
  let body: Buffer;
  try {
    body = await fs.readFile(file.source);
  } catch {
    return undefined;
  }
  const violations = inspectSvg(body.toString('utf8'));
  if (violations.length === 0) return body;
  logger.warn(
    { type: 'asset.svg_rejected', file: file.rel, violations },
    'SVG の検査に違反したため配信ルートへ置きません(この画像は表示されません)',
  );
  return undefined;
}
```

`stageDocAssets` のループの本体（`const dest = …` から `served.add(file.rel);` の手前まで）を置き換える:

```ts
  for (const file of wanted) {
    if (files >= MAX_ASSET_FILES || bytes + file.bytes > MAX_ASSET_BYTES) return served;
    // SVG は参照されたものだけをここで検査する(目録づくりの段では読まない = 全画像を毎回
    // 読まない)。違反は置かず、参照は `inlineCss` の判断で落ちる。
    let body: Buffer | undefined;
    if (path.extname(file.rel).toLowerCase() === '.svg') {
      body = await readInspectedSvg(file);
      if (body === undefined) continue;
    }
    const dest = path.join(destDir, ...file.rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      // `COPYFILE_EXCL` / `wx` = 既存があれば失敗。配信ルートに先着の実体があればそちらを残す
      // (zip 展開物のように既に同名がある配信ルートを我々の資産で上書きしない)。
      if (body === undefined) await fs.copyFile(file.source, dest, fs.constants.COPYFILE_EXCL);
      else await fs.writeFile(dest, body, { flag: 'wx' });
    } catch {
      // (既存のコメントと exists 判定はそのまま残す)
```

`catch` ブロックの中身（`const exists = …` と `if (!exists) continue;`）と、その後の `served.add` 以降は不変。

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/docAssets.test.ts test/docRefs.test.ts test/inlineCss.test.ts test/mergeInput.test.ts test/previewHost.test.ts`
Expected: PASS。既存の `docAssets.test.ts` で、全件配置（`referenced` 省略）の件数を数えるテストが images の置き場の無い環境を前提にしていても、置き場が無ければ空なので結果は変わらない。

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/server/src/vivliostyle/docAssets.ts editor/server/test/docAssets.test.ts
git add editor/server/src/vivliostyle/docAssets.ts editor/server/test/docAssets.test.ts
git commit -m "feat(editor): 配信の許可リストに直下限定の images グループを足し、配置する SVG を検査して違反を置かない"
```

---

### Task 4: 単体配信ルート `GET /api/fund-assets/images/:file` を足し、プレビューホストは images/ を配らない

**Files:**
- Create: `editor/server/src/routes/fundAssets.routes.ts`
- Create: `editor/server/test/fundAssets.routes.test.ts`
- Modify: `editor/shared/src/api-paths.ts`（`apiPaths` の vivliostyle 節の後ろ）
- Modify: `editor/server/src/routes/routeGuards.ts`（`ROUTE_POLICY` の render 節の後ろ）
- Modify: `editor/server/src/app.ts`（import と `app.register(usersRoutes, …)` の直後）
- Modify: `editor/server/src/openapi/document.ts`（`PdfBinary` の直後、`'/build'` の直前）→ `editor/server/openapi/openapi.json` 再生成
- Modify: `editor/server/src/vivliostyle/previewHost.ts`（import、資産ルートの `resolveServedAssetPath` の直後、コメント 405-407 行）
- Modify: `editor/server/test/previewHost.test.ts`（env と置き場、404 のテスト）
- Modify: `editor/server/test/routeGuards.test.ts`（登録するモジュールの一覧）
- Modify: `editor/server/test/guardCoverage.guard.test.ts`（末尾に describe 1 つ）

**Interfaces:**
- Consumes: `inspectSvg`（Task 1）、`FUND_IMAGES_MOUNT`・`isFundImagePath`・`resolveServedAssetSource`（Task 3）
- Produces: `apiPaths.fundAssetImage = '/fund-assets/images/:file'`、`export async function fundAssetsRoutes(app: FastifyInstance): Promise<void>`、`export async function resolveFundImageSource(file: string): Promise<string | undefined>`

- [ ] **Step 1: 失敗するテストを書く**

`editor/server/test/fundAssets.routes.test.ts`:

```ts
// =============================================================================
// fundAssets.routes.test.ts — ファンド別画像の単体配信ルートの関所(認証・経路・SVG 検査・ヘッダ)
// =============================================================================
// 画面内プレビューと編集画面が画像を取る唯一の経路。ここが緩むと、検査を通らない SVG が
// 同一オリジンで開ける面になる。迂回入力では 1 バイトも出さないこと、SVG の応答だけ全域 CSP が
// `sandbox` へ置き換わることを主張する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionStub, decorateSessionStore } from './helpers/sessionStub.js';

vi.mock('../src/auth/session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/session.js')>()),
  sessionIdFrom: (cookieHeader: string | undefined) => cookieHeader || undefined,
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-fund-assets-'));
const imagesDir = path.join(root, 'data', 'images');
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'false';
process.env.DATA_ROOT = path.join(root, 'data');
process.env.CSS_DIR = path.join(root, 'data', 'css');
process.env.IMAGES_DIR = imagesDir;
process.env.LOG_DIR = path.join(root, 'logs');

const NS = 'http://www.w3.org/2000/svg';
const GOOD_SVG = `<svg xmlns="${NS}" width="10" height="10"><rect width="10" height="10"/></svg>`;
const BAD_SVG = `<svg xmlns="${NS}" onload="alert(1)"><rect width="10" height="10"/></svg>`;
const as = (sid: string) => ({ cookie: sid });
const URL_BASE = '/api/fund-assets/images';

let app: FastifyInstance;

beforeAll(async () => {
  fs.mkdirSync(path.join(imagesDir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'css'), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, '510037_logo.svg'), GOOD_SVG);
  fs.writeFileSync(path.join(imagesDir, '510037_bad.svg'), BAD_SVG);
  fs.writeFileSync(path.join(imagesDir, '510037_photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(imagesDir, '510037_anim.gif'), 'GIF89a');
  fs.writeFileSync(path.join(imagesDir, 'sub', '510037_deep.svg'), GOOD_SVG);
  fs.writeFileSync(path.join(root, 'data', 'css', '510037.css'), 'SECRET_CSS{}');

  const Fastify = (await import('fastify')).default;
  const helmet = (await import('@fastify/helmet')).default;
  const { buildCspDirectives } = await import('../src/config.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { fundAssetsRoutes } = await import('../src/routes/fundAssets.routes.js');
  const store = createSessionStub({
    getSessionUser: (sid) =>
      sid === 'viewer'
        ? {
            id: 'id-viewer',
            username: 'viewer',
            displayName: '閲覧',
            role: 'viewer' as const,
            disabled: false,
            mustChangePassword: false,
          }
        : null,
  });
  app = Fastify();
  app.decorateRequest('user', undefined);
  decorateSessionStore(app, store);
  app.setErrorHandler(errorHandler);
  // `app.ts` と同じ順序: helmet(全域)→ ルート。SVG の CSP は onSend で上書きする。
  app.register(helmet, {
    contentSecurityPolicy: { useDefaults: true, directives: buildCspDirectives([]) },
  });
  app.register(fundAssetsRoutes, { prefix: '/api' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GET /api/fund-assets/images/:file', () => {
  it('認証なしは 401', async () => {
    const res = await app.inject({ method: 'GET', url: `${URL_BASE}/510037_logo.svg` });
    expect(res.statusCode).toBe(401);
  });

  it('SVG を image/svg+xml・nosniff・no-store・CSP sandbox で返す', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/510037_logo.svg`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(GOOD_SVG);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('png は image/png で返し、CSP は全域のまま', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/510037_photo.png`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('検査に違反した SVG は 404 で、本文を出さない', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${URL_BASE}/510037_bad.svg`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('onload');
  });

  it.each([
    ['..', `${URL_BASE}/..`],
    ['%2F で区切ったサブフォルダ', `${URL_BASE}/sub%2F510037_deep.svg`],
    ['%5C で区切ったサブフォルダ', `${URL_BASE}/sub%5C510037_deep.svg`],
    ['%2F で css へ遡る', `${URL_BASE}/..%2Fcss%2F510037.css`],
    ['二重符号化の ..', `${URL_BASE}/%252e%252e%252Fcss%252F510037.css`],
    ['サブフォルダ', `${URL_BASE}/sub/510037_deep.svg`],
    ['予約名', `${URL_BASE}/CON.svg`],
    ['予約名(小文字・拡張子付き)', `${URL_BASE}/com1.png`],
    ['許可外の拡張子', `${URL_BASE}/510037_anim.gif`],
    ['存在しない', `${URL_BASE}/510037_none.svg`],
  ])('%s は 404 で、本文を出さない', async (_label, url) => {
    const res = await app.inject({ method: 'GET', url, headers: as('viewer') });
    expect(res.statusCode, `${url} → ${res.statusCode}`).toBe(404);
    expect(res.body).not.toContain('SECRET_CSS');
    expect(res.body).not.toContain('<svg');
  });
});
```

`previewHost.test.ts` の env に `process.env.IMAGES_DIR = path.join(tmp, 'images');` を足し、`beforeAll` の置き場づくりに次を足す:

```ts
  fs.mkdirSync(path.join(tmp, 'images'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'images', '510037_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    'utf8',
  );
```

`describe('GET /api/preview-host/* — 同梱資産の配信', …)` の末尾に追加:

```ts
  it('images/ は配らない(画像の配信経路は /api/fund-assets/images/ の 1 本)', async () => {
    for (const url of [
      '/api/preview-host/images/510037_logo.svg',
      '/api/preview-host/Images/510037_logo.svg',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('<svg');
    }
  });
```

`routeGuards.test.ts` の登録モジュールの一覧で `'../src/routes/users.routes.js',` の直後に追加:

```ts
    '../src/routes/fundAssets.routes.js',
```

`guardCoverage.guard.test.ts` の末尾に追加:

```ts
describe('画像の配信面は SVG 検査を通る', () => {
  // 資産の解決器(`resolveServedAssetSource`)は images グループも引ける。呼び出し元が増えたとき、
  // その経路が SVG 検査も images/ の拒否もしていなければ、検査を通らない SVG の配信面が開く。
  it('resolveServedAssetSource の呼び出し元は inspectSvg を呼ぶか images/ を拒む', () => {
    const callers = sourceFiles(SERVER_SRC, ['.ts'])
      .filter((f) => path.basename(f) !== 'docAssets.ts')
      .filter((f) => /resolveServedAssetSource\s*\(/.test(read(f)))
      .map((f) => path.relative(SERVER_SRC, f).replaceAll('\\', '/'))
      .sort();
    expect(callers).toEqual(['routes/fundAssets.routes.ts', 'vivliostyle/previewHost.ts']);
    for (const rel of callers) {
      const src = read(path.join(SERVER_SRC, rel));
      expect(
        src.includes('inspectSvg(') || src.includes('isFundImagePath('),
        `${rel} が SVG 検査も images/ の拒否もしていない`,
      ).toBe(true);
    }
  });

  it('配置(stageDocAssets)も SVG を検査する', () => {
    expect(read(path.join(SERVER_SRC, 'vivliostyle', 'docAssets.ts'))).toContain('inspectSvg(');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter server exec vitest run test/fundAssets.routes.test.ts test/previewHost.test.ts test/routeGuards.test.ts test/guardCoverage.guard.test.ts`
Expected: FAIL（`fundAssets.routes.js` が無い、プレビューホストが images/ を 200 で返す）

- [ ] **Step 3: 実装する**

`api-paths.ts` の `previewById: '/preview/:id',` の直後に追加:

```ts
  // fund assets (別ツールが置くファンド別画像。imagesDir 直下の 1 ファイル)
  fundAssetImage: '/fund-assets/images/:file',
```

`editor/server/src/routes/fundAssets.routes.ts`:

```ts
// =============================================================================
// fundAssets.routes.ts — ファンド別画像(imagesDir 直下)を 1 つ返す読み取り専用ルート
// =============================================================================
// 画面内プレビュー(親が取得して data URI に埋める)と編集画面(canvas の CSS が
// `content:url()` で引く)の唯一の取得先。プレビューホストの資産ルートは `images/` を配らない
// ので、SVG 検査を通らない画像の配信経路は無い(`test/guardCoverage.guard.test.ts` が固定する)。
//
// 経路の検査は 2 段: `resolveServedAssetPath`(`\`・`..`・絶対参照の拒否。プレビューホストと
// 同じ前段)→ `resolveServedAssetSource`(許可リスト・直下限定・symlink 拒否を PDF の配置と
// 共有する)。別の解決器は作らない。Windows の予約名は lstat が装置として成功しうるので、
// 実体に触れる前に名前で落とす。
//
// 閲覧権限は CSS と同じ(ログインしていれば全ファンドの画像を見られる)。応答は `no-store` —
// 画像は外部ツールが差し替えるため、古い版をブラウザに残さない。

import fs from 'node:fs/promises';
import path from 'node:path';
import { apiPaths, inspectSvg, resolveServedAssetPath } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { FUND_IMAGES_MOUNT, resolveServedAssetSource } from '../vivliostyle/docAssets.js';

/** 拡張子 → Content-Type。許可リスト外の拡張子は解決器が先に弾く。 */
const IMAGE_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

/** Windows の予約デバイス名(拡張子付きを含む)。 */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 直接開かれた SVG を opaque オリジンに閉じ込める CSP。`<img>` / CSS `content:url()` として
 * 読まれる限りスクリプトは動かないが、URL を直接開かれた場合に同一オリジンの文書にしない。
 */
const SVG_CSP = 'sandbox';

/**
 * ルートのファイル名から実体の絶対パスを引く。正規化で形が変わる入力(`..`・`%xx` の
 * 二重符号化・前後の空白)は、どこを指すかを推測せずに拒む。
 */
export async function resolveFundImageSource(file: string): Promise<string | undefined> {
  if (WINDOWS_RESERVED_RE.test(file)) return undefined;
  const wanted = `${FUND_IMAGES_MOUNT}/${file}`;
  if (resolveServedAssetPath(wanted) !== wanted) return undefined;
  return resolveServedAssetSource(wanted);
}

/**
 * 画像の単体配信ルート。`app.register(fundAssetsRoutes, { prefix: '/api' })` のように
 * fastify-plugin を通さずに登録する = 独自コンテキストになり、下の `onSend` はこのルートにだけ
 * 掛かる(`vivliostyle/previewHost.ts` と同じ作法)。helmet は `onRequest` でヘッダを置くので、
 * `onSend` の上書きが必ず勝つ。
 */
export async function fundAssetsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    if (String(reply.getHeader('content-type') ?? '').startsWith('image/svg+xml')) {
      reply.header('content-security-policy', SVG_CSP);
    }
  });

  app.get<{ Params: { file: string } }>(
    apiPaths.fundAssetImage,
    { preHandler: requireAuth },
    async (request, reply) => {
      const { file } = request.params;
      const source = await resolveFundImageSource(file);
      const type =
        source === undefined
          ? undefined
          : IMAGE_CONTENT_TYPES.get(path.extname(source).toLowerCase());
      // 存在しない / 配信対象外 / 違反は区別せず 404 本文なし(理由を外へ漏らさない)。
      if (source === undefined || type === undefined) return reply.code(404).send();
      let body: Buffer;
      try {
        body = await fs.readFile(source);
      } catch {
        return reply.code(404).send();
      }
      if (type === 'image/svg+xml') {
        const violations = inspectSvg(body.toString('utf8'));
        if (violations.length > 0) {
          logger.warn(
            { type: 'asset.svg_rejected', file: `${FUND_IMAGES_MOUNT}/${file}`, violations },
            'SVG の検査に違反したため配信しません',
          );
          return reply.code(404).send();
        }
      }
      return reply.type(type).send(body);
    },
  );
}
```

`routeGuards.ts` の render 節（`[`GET ${api(RENDER_HOST_BASE)}/*`]: 'auth',`）の直後に追加:

```ts

  // ファンド別画像(imagesDir 直下)。閲覧そのものなので viewer にも開く(CSS と同じ権限)。
  [`GET ${api(apiPaths.fundAssetImage)}`]: 'auth',
```

`app.ts` の import に `import { fundAssetsRoutes } from './routes/fundAssets.routes.js';` を足し、`app.register(usersRoutes, { prefix: '/api', deps });` の直後に追加:

```ts
  // ファンド別画像。SVG だけ全域 CSP を `sandbox` で上書きするため、fastify-plugin を通さない
  // 独自コンテキストで登録する(onSend がこのルートにだけ掛かる)。
  app.register(fundAssetsRoutes, { prefix: '/api' });
```

`previewHost.ts` の import の `resolveServedAssetSource` を `isFundImagePath, resolveServedAssetSource` にし、資産ルートの `if (rel === undefined) return reply.code(404).send();` の直後に追加:

```ts
      // 画像の配信経路は `/api/fund-assets/images/` の 1 本に集める。ここで配ると SVG 検査を
      // 通らない経路ができる(子の画像は親が文書へ埋めるので、子がここへ取りに来る必要も無い)。
      if (isFundImagePath(rel)) return reply.code(404).send();
```

同じルートの直前のコメントの「(`css/`(配下に `css/fonts/`)と `js/`)」を「(`css/`(配下に `css/fonts/`)と `js/`。`images/` は配らない)」に直す。

`openapi/document.ts` の `const PdfBinary = …;` の直後に追加:

```ts
// 画像のバイナリペイロード。
const ImageBinary = z.string().meta({ format: 'binary', description: '画像バイナリ' });
```

`'/build': {` の直前に追加:

```ts
      [toOpenApiPath(apiPaths.fundAssetImage)]: {
        get: {
          tags: ['vivliostyle'],
          summary: 'ファンド別画像(images/)を 1 つ返す',
          operationId: 'getFundAssetImage',
          description: [
            '`imagesDir` 直下の画像(`.svg` `.png` `.jpg` `.jpeg`)を返す。',
            'ファイル名は `<fund>_<画像名>.<拡張子>` の約束だが、名前の規則は検査しない。',
            'サブフォルダ・`..`・`\\`・Windows の予約名(`CON` など)・許可外の拡張子は 404。',
            'SVG は許可リスト型の検査を通り、違反なら 404(本文なし)。',
            '応答は `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を持ち、',
            'SVG には `Content-Security-Policy: sandbox` を付ける。',
          ].join(''),
          requestParams: { path: z.object({ file: z.string() }) },
          responses: {
            '200': {
              description: '画像',
              content: {
                'image/svg+xml': { schema: ImageBinary },
                'image/png': { schema: ImageBinary },
                'image/jpeg': { schema: ImageBinary },
              },
            },
            ...ERR_401,
            '404': { description: '対象が無い / 配信対象外 / SVG 検査の違反(本文なし)' },
          },
        },
      },
```

- [ ] **Step 4: OpenAPI を再生成する**

Run: `pnpm --filter @editor/shared run build && pnpm --filter server run openapi:gen`
Expected: `editor/server/openapi/openapi.json` に `/fund-assets/images/{file}` が増える。

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm --filter server exec vitest run test/fundAssets.routes.test.ts test/previewHost.test.ts test/routeGuards.test.ts test/guardCoverage.guard.test.ts test/openapi.test.ts test/openapiArtifact.guard.test.ts`
Expected: PASS。`..` のケースで Fastify が 400 を返す版なら、期待値を `[400, 404]` の包含に緩めてよい（本文を出さないことの主張は残す）。

Run: `pnpm typecheck:editor`
Expected: エラー 0

- [ ] **Step 6: コミット**

```bash
pnpm exec biome check --write editor/shared/src/api-paths.ts editor/server/src/routes/fundAssets.routes.ts editor/server/src/routes/routeGuards.ts editor/server/src/app.ts editor/server/src/openapi/document.ts editor/server/src/vivliostyle/previewHost.ts editor/server/test/fundAssets.routes.test.ts editor/server/test/previewHost.test.ts editor/server/test/routeGuards.test.ts editor/server/test/guardCoverage.guard.test.ts
git add editor/shared/src/api-paths.ts editor/server/src/routes/fundAssets.routes.ts editor/server/src/routes/routeGuards.ts editor/server/src/app.ts editor/server/src/openapi/document.ts editor/server/openapi/openapi.json editor/server/src/vivliostyle/previewHost.ts editor/server/test/fundAssets.routes.test.ts editor/server/test/previewHost.test.ts editor/server/test/routeGuards.test.ts editor/server/test/guardCoverage.guard.test.ts
git commit -m "feat(editor): ファンド別画像の単体配信ルートを足し、SVG は検査して sandbox で返す。プレビューホストは images/ を配らない"
```

---

### Task 5: 画面内プレビューで images/ の画像を data URI に埋める

**Files:**
- Create: `editor/web/src/lib/fundImages.ts`
- Create: `editor/web/test/libFundImages.test.ts`
- Modify: `editor/web/src/lib/previewSelfContain.ts`（冒頭コメント、import、キャッシュ、`inlineFonts` → `inlineStyleAssets`、`selfContainPreviewDoc`）
- Modify: `editor/web/test/previewSelfContain.dom.test.ts`
- Modify: `vitest.config.ts`（coverage include の `'editor/web/src/lib/previewSelfContain.ts',` の直後）

**Interfaces:**
- Consumes: `apiPaths.fundAssetImage`（Task 4）、`buildPath`・`resolveServedAssetPath`（shared）
- Produces: `export const FUND_IMAGES_DIR = 'images'`、`export function fundImageMime(file: string): string | undefined`、`export function fundImageFileOf(ref: string): string | undefined`、`export function fundImageUrl(file: string): string`（`web/src/lib/fundImages.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/libFundImages.test.ts`:

```ts
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
```

`previewSelfContain.dom.test.ts` の import に `import { isSelfContainedUrl } from '@editor/shared';` を足し、ファイル末尾に追加:

```ts
/** 完全 URL 単位で応答を組み立てる fetcher(画像は /api/fund-assets/… から取る)。 */
function fetcherForUrls(routes: Record<string, string | Uint8Array>) {
  return vi.fn(async (url: string): Promise<Response> => {
    const hit = routes[url];
    if (hit === undefined) return new Response(null, { status: 404 });
    return new Response(hit, { status: 200 });
  });
}

const LOGO_URL = '/api/fund-assets/images/510037_logo.svg';
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

describe('ファンド別画像の data: URI 化', () => {
  it('<img src="images/…svg"> を data:image/svg+xml に置き換える(取得先は単体配信ルート)', async () => {
    const fetcher = fetcherForUrls({ [LOGO_URL]: LOGO_SVG });
    const out = await selfContainPreviewDoc(DOC('<img src="images/510037_logo.svg">'), fetcher);
    expect(fetcher).toHaveBeenCalledWith(LOGO_URL);
    expect(out).toContain('src="data:image/svg+xml;base64,');
    expect(out).not.toContain('src="images/');
  });

  it('png も data:image/png に置き換える', async () => {
    const fetcher = fetcherForUrls({
      '/api/fund-assets/images/510037_photo.png': new Uint8Array([0x89, 0x50]),
    });
    const out = await selfContainPreviewDoc(DOC('<img src="images/510037_photo.png">'), fetcher);
    expect(out).toContain('src="data:image/png;base64,');
  });

  it('<style> 内の url(images/…) を置き換える(付け替え後の引用形でも)', async () => {
    const fetcher = fetcherForUrls({ [LOGO_URL]: LOGO_SVG });
    const out = await selfContainPreviewDoc(
      DOC('<p class="a">x</p>', '<style>.a{background:url("images/510037_logo.svg")}</style>'),
      fetcher,
    );
    expect(out).toContain('url(data:image/svg+xml;base64,');
  });

  it('違反 SVG(単体配信ルートが 404)は埋めず原文のまま', async () => {
    const fetcher = fetcherForUrls({});
    const out = await selfContainPreviewDoc(DOC('<img src="images/510037_bad.svg">'), fetcher);
    expect(out).toContain('src="images/510037_bad.svg"');
  });

  it('サブフォルダ・許可外拡張子・images 以外は取りに行かない', async () => {
    const fetcher = fetcherForUrls({});
    await selfContainPreviewDoc(
      DOC('<img src="images/sub/a.svg"><img src="images/a.gif"><img src="photos/a.png">'),
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('上限を超える画像は埋めない', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const fetcher = fetcherForUrls({ '/api/fund-assets/images/510037_big.png': big });
    const out = await selfContainPreviewDoc(DOC('<img src="images/510037_big.png">'), fetcher);
    expect(out).toContain('src="images/510037_big.png"');
  });

  it('同じ画像は 1 回しか取りに行かない', async () => {
    const fetcher = fetcherForUrls({ [LOGO_URL]: LOGO_SVG });
    const doc = DOC('<img src="images/510037_logo.svg"><img src="images/510037_logo.svg">');
    await selfContainPreviewDoc(doc, fetcher);
    await selfContainPreviewDoc(doc, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('共有の data: 許可リストは SVG を含まないまま(埋め込みが作る data: だけが例外)', () => {
    expect(isSelfContainedUrl('data:image/svg+xml;base64,AAAA')).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter web exec vitest run test/libFundImages.test.ts test/previewSelfContain.dom.test.ts`
Expected: FAIL（`@/lib/fundImages` が無い、`<img src>` が置き換わらない）

- [ ] **Step 3: 実装する**

`editor/web/src/lib/fundImages.ts`:

```ts
// =============================================================================
// fundImages.ts — ファンド別画像(images/)の配信 URL とファイル名の判定(web 共通)
// =============================================================================
// ファンド別画像は別ツールが `dataRoot/images/` 直下に置き、web はサーバの
// `GET /api/fund-assets/images/:file` だけから取る(SVG 検査と認証を通る唯一の経路)。
// 画面内プレビュー(`previewSelfContain.ts`)と編集画面(`features/editor/fundImages.ts`)が
// 同じ判定と URL を使うよう、ここに 1 つだけ置く。拡張子はサーバの `vivliostyle/docAssets.ts` の
// images グループと揃える — 片方だけ広げると、取りに行っても 404 になるだけの参照を作る。

import { apiPaths, buildPath, resolveServedAssetPath } from '@editor/shared';

/** 配信ルートでの置き場の名前(テンプレの相対参照 `images/…` の先頭)。 */
export const FUND_IMAGES_DIR = 'images';

/** 拡張子 → MIME。`Map` なのは、利用者入力の拡張子で `Object.prototype` を引かないため。 */
const FUND_IMAGE_MIME: ReadonlyMap<string, string> = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

/** ファイル名の拡張子から MIME を引く。許可外は `undefined`。 */
export function fundImageMime(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? undefined : FUND_IMAGE_MIME.get(file.slice(dot).toLowerCase());
}

/**
 * 文書中の参照値(`<img src>` / CSS の `url()`)が images 直下の 1 ファイルを指すなら、その
 * ファイル名を返す。判定は配信ルートの正規化(`resolveServedAssetPath`)を通した形で行う。
 */
export function fundImageFileOf(ref: string): string | undefined {
  const rel = resolveServedAssetPath(ref);
  if (rel === undefined) return undefined;
  const segments = rel.split('/');
  if (segments.length !== 2 || segments[0] !== FUND_IMAGES_DIR) return undefined;
  return fundImageMime(segments[1]) === undefined ? undefined : segments[1];
}

/** ファイル名 → 単体配信ルートの URL(同一オリジン。cookie が付く)。 */
export function fundImageUrl(file: string): string {
  return `/api${buildPath(apiPaths.fundAssetImage, { file })}`;
}
```

`previewSelfContain.ts` の冒頭コメントの「加工の作法」の前に 1 段落足す:

```ts
// ファンド別画像(`<img src="images/…">` と `<style>` 内の `url(images/…)`)も同じ理由で埋める。
// 取得先は単体配信ルート `/api/fund-assets/images/:file`(SVG 検査と認証を通る唯一の経路)で、
// プレビューホストは `images/` を配らない。`data:image/svg+xml` は**ここが作るときだけ**使い、
// 共有の data: 許可リストには足さない(テンプレの著者が未検査の SVG を直接書ける経路を開かない)。
```

import に追加:

```ts
import { fundImageFileOf, fundImageMime, fundImageUrl } from './fundImages';
```

`MAX_INLINE_FONT_BYTES` の直後に追加:

```ts
/** data: URI 化する 1 画像のサイズ上限(フォントと同じ考え方。超えたものは埋めない)。 */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
```

キャッシュに `const imageCache = new Map<string, Promise<string | undefined>>();` を足し、`resetSelfContainCache` に `imageCache.clear();` を足す。`fetchFontDataUri` の直後に追加:

```ts
/**
 * images 直下の 1 ファイルを data: URI にする。key はファイル名。キャッシュはページの寿命で、
 * 外部ツールが画像を差し替えたときの反映はブラウザの再読み込みに任せる(運用手順書)。
 */
async function fetchImageDataUri(file: string, fetcher: AssetFetcher): Promise<string | undefined> {
  const cached = imageCache.get(file);
  if (cached !== undefined) return cached;
  const p = (async () => {
    const mime = fundImageMime(file);
    if (mime === undefined) return undefined;
    try {
      const res = await fetcher(fundImageUrl(file));
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) return undefined;
      return `data:${mime};base64,${toBase64(buf)}`;
    } catch {
      return undefined;
    }
  })();
  imageCache.set(file, p);
  return p;
}

/** `<img src="images/…">` を data: URI へ置き換える。埋められないものは原文のまま残す。 */
async function inlineImages(root: Element, fetcher: AssetFetcher): Promise<void> {
  for (const img of Array.from(root.querySelectorAll('img[src]'))) {
    const file = fundImageFileOf(img.getAttribute('src') ?? '');
    if (file === undefined) continue;
    const dataUri = await fetchImageDataUri(file, fetcher);
    if (dataUri !== undefined) img.setAttribute('src', dataUri);
  }
}
```

`inlineFonts` を `inlineStyleAssets` に改名し、doc コメントの 1 行目を「`<style>` 内の `url(css/fonts/…)` と `url(images/…)` を data: URI へ置き換える。」にする。ループの本体を置き換える:

```ts
    for (const span of [...spans].reverse()) {
      const rel = resolveServedAssetPath(span.value);
      if (rel === undefined) continue;
      let dataUri: string | undefined;
      if (rel.startsWith('css/fonts/')) {
        dataUri = await fetchFontDataUri(rel, fetcher);
      } else {
        const file = fundImageFileOf(rel);
        if (file !== undefined) dataUri = await fetchImageDataUri(file, fetcher);
      }
      if (dataUri === undefined) continue;
      out = `${out.slice(0, span.start)}url(${dataUri})${out.slice(span.end)}`;
      changed = true;
    }
```

`selfContainPreviewDoc` の本体を置き換える:

```ts
  const root = sanitizePreviewRoot(doc);
  await inlineScripts(root, fetcher);
  await inlineImages(root, fetcher);
  await inlineStyleAssets(root, fetcher);
  return serializePreviewRoot(root);
```

`vitest.config.ts` の coverage include で `'editor/web/src/lib/previewSelfContain.ts',` の直後に追加:

```ts
        'editor/web/src/lib/fundImages.ts',
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter web exec vitest run test/libFundImages.test.ts test/previewSelfContain.dom.test.ts test/noPostSanitizeSurgery.guard.test.ts`
Expected: PASS（既存のフォント埋め込みのテストを含む）

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/lib/fundImages.ts editor/web/src/lib/previewSelfContain.ts editor/web/test/libFundImages.test.ts editor/web/test/previewSelfContain.dom.test.ts
git add editor/web/src/lib/fundImages.ts editor/web/src/lib/previewSelfContain.ts editor/web/test/libFundImages.test.ts editor/web/test/previewSelfContain.dom.test.ts vitest.config.ts
git commit -m "feat(web): 画面内プレビューで images/ の画像を単体配信ルートから取得して data URI に埋める"
```

---

### Task 6: 編集画面の画像表示の純関数（対象の判定・ファンドコード・CSS の生成）

**Files:**
- Create: `editor/web/src/features/editor/fundImages.ts`
- Create: `editor/web/test/fundImages.test.ts`
- Modify: `vitest.config.ts`（coverage include の `'editor/web/src/features/editor/pageView.ts',` の直後）

**Interfaces:**
- Consumes: `FUND_IMAGES_DIR`・`fundImageFileOf`・`fundImageUrl`（Task 5）、`parseTemplateFileName`（shared）
- Produces:
  - `export type FundImageMode = 'jinja' | 'filled'`
  - `export interface FundImageContext { mode: FundImageMode; fundCode: string | null }`
  - `export const FUND_IMAGE_WARNING_MESSAGE: string`
  - `export function fundCodeOfTemplateId(templateId: string): string | null`
  - `export function resolveFundImageSrc(src: string, ctx: FundImageContext): string | null`（配信するファイル名。対象外は null）
  - `export function needsFundImageWarning(srcs: Iterable<string>, ctx: FundImageContext): boolean`
  - `export function cssString(value: string): string`
  - `export function fundImageCss(srcs: Iterable<string>, ctx: FundImageContext): { css: string; urls: string[] }`

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/fundImages.test.ts`:

```ts
// =============================================================================
// fundImages.test.ts — 編集画面でファンド別画像を差す対象と CSS の固定
// =============================================================================
// 差す範囲は PDF・プレビューと同じにする(編集画面だけ見えるずれを作らない)。Jinja 本文は
// `{{ fund.code }}` をテンプレ ID のファンドコードで解き、値入り本文は確定パスだけを差す。
import { buildSampleData, parseTemplateFileName } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import {
  cssString,
  FUND_IMAGE_WARNING_MESSAGE,
  fundCodeOfTemplateId,
  fundImageCss,
  needsFundImageWarning,
  resolveFundImageSrc,
} from '@/features/editor/fundImages';

const ID = 'AM01_510037_20250105_交付版';
const JINJA = { mode: 'jinja' as const, fundCode: '510037' };
const FILLED = { mode: 'filled' as const, fundCode: '510037' };

describe('fundCodeOfTemplateId', () => {
  it('テンプレ ID からファンドコードを取り出す(不正な ID は null)', () => {
    expect(fundCodeOfTemplateId(ID)).toBe('510037');
    expect(fundCodeOfTemplateId('not-a-template')).toBeNull();
  });

  it('buildSampleData が fund.code に入れる値と出所が一致する', () => {
    const attrs = parseTemplateFileName(`${ID}.html`);
    expect(attrs).not.toBeNull();
    const fund = buildSampleData(undefined, attrs?.fundCode ?? '').fund as { code: string };
    expect(fundCodeOfTemplateId(ID)).toBe(fund.code);
  });
});

describe('resolveFundImageSrc', () => {
  it.each([
    'images/{{ fund.code }}_logo.svg',
    'images/{{fund.code}}_logo.svg',
    'images/{{   fund.code   }}_logo.svg',
    'images/510037_logo.svg',
  ])('Jinja 本文: %s は 510037_logo.svg を差す', (src) => {
    expect(resolveFundImageSrc(src, JINJA)).toBe('510037_logo.svg');
  });

  it('Jinja 本文でもファンドコードが分からなければ解かない', () => {
    expect(resolveFundImageSrc('images/{{ fund.code }}_logo.svg', { ...JINJA, fundCode: null })).toBeNull();
  });

  it('値入り本文は確定パスだけを差し、{{ … }} の残る参照は解かない', () => {
    expect(resolveFundImageSrc('images/510037_logo.svg', FILLED)).toBe('510037_logo.svg');
    expect(resolveFundImageSrc('images/{{ fund.code }}_logo.svg', FILLED)).toBeNull();
  });

  it.each([
    'images/{{ report.x }}_logo.svg',
    'images/{% if a %}x{% endif %}.svg',
    'photos/510037_logo.svg',
    '/images/510037_logo.svg',
    'images/sub/510037_logo.svg',
    'images/510037_anim.gif',
    'images/../css/x.svg',
    'https://evil.example/images/510037_logo.svg',
  ])('%s は対象外', (src) => {
    expect(resolveFundImageSrc(src, JINJA)).toBeNull();
    expect(resolveFundImageSrc(src, FILLED)).toBeNull();
  });
});

describe('needsFundImageWarning', () => {
  it('値入り本文に {{ の残る images/ 参照があるときだけ真', () => {
    expect(needsFundImageWarning(['images/{{ fund.code }}_logo.svg'], FILLED)).toBe(true);
    expect(needsFundImageWarning(['images/{{ fund.code }}_logo.svg'], JINJA)).toBe(false);
    expect(needsFundImageWarning(['images/510037_logo.svg', 'photos/{{ x }}.png'], FILLED)).toBe(
      false,
    );
  });

  it('警告文は {{ fund.code }} を字面で含む(Vue の補間に渡さず定数で出す)', () => {
    expect(FUND_IMAGE_WARNING_MESSAGE).toContain('{{ fund.code }}');
  });
});

describe('cssString / fundImageCss', () => {
  it('CSS の文字列として安全に引用する', () => {
    expect(cssString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(cssString('a\nb')).toBe('"a\\a b"');
    expect(cssString('</style>')).toBe('"\\3c /style\\3e "');
  });

  it('原文の src の字面でセレクタを書き、配信 URL を content に置く', () => {
    const { css, urls } = fundImageCss(
      [
        'images/{{ fund.code }}_logo.svg',
        'images/510037_logo.svg',
        'images/{{ fund.code }}_logo.svg',
        'photos/x.png',
      ],
      JINJA,
    );
    expect(css).toBe(
      'img[src="images/{{ fund.code }}_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}\n' +
        'img[src="images/510037_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}',
    );
    expect(urls).toEqual(['/api/fund-assets/images/510037_logo.svg']);
  });

  it('対象が無ければ空', () => {
    expect(fundImageCss(['photos/x.png'], FILLED)).toEqual({ css: '', urls: [] });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter web exec vitest run test/fundImages.test.ts`
Expected: FAIL（`@/features/editor/fundImages` が無い）

- [ ] **Step 3: 実装する**

`editor/web/src/features/editor/fundImages.ts`:

```ts
// =============================================================================
// fundImages.ts — 編集画面でファンド別画像を差すための純関数(対象の判定と CSS の生成)
// =============================================================================
// 編集画面(GrapesJS の canvas)は相対 URL をアプリの URL 基準で解くので、`images/…` は必ず
// 404 になる。属性を書き換えて直すと、文字編集・ペースト・Undo・`getHtml` のどこかで配信 URL が
// 保存内容へ混ざる経路が残る。だから属性には触らず、canvas 専用の `<style>` に
// `img[src="<原文>"]{content:url("<配信 URL>")}` を書いて表示だけを差し替える(DOM とモデルが
// 変わらないので、保存内容は原理的に原文のまま)。
//
// 差す範囲は PDF・プレビューと同じにする(編集画面だけ見えるずれを作らない):
//  - Jinja 本文(作成タブと、値入り HTML の無いテンプレ)は描画で `{{ fund.code }}` が展開される
//    ので、同じ値(テンプレ ID のファンドコード = `buildSampleData` が `fund.code` に入れる値)で解く。
//  - 値入り本文(編集タブ)は描画を通らないので、確定したパスだけを差す。`{{` が残る参照は
//    PDF にも出ないため解かず、警告で外部ツール側の修正を促す。
// GrapesJS への配線は `fundImageLayer.ts`。

import { parseTemplateFileName } from '@editor/shared';
import { FUND_IMAGES_DIR, fundImageFileOf, fundImageUrl } from '@/lib/fundImages';

/** 本文の種類。`jinja` = 描画を通る本文、`filled` = 値入り HTML(描画を通らない)。 */
export type FundImageMode = 'jinja' | 'filled';

export interface FundImageContext {
  mode: FundImageMode;
  /** テンプレ ID のファンドコード。ID が規約に合わなければ null(Jinja の参照を解かない)。 */
  fundCode: string | null;
}

/**
 * 値入り本文に `{{ … }}` 入りの画像参照が残っているときの警告。テンプレート構文の字面を含むので、
 * Vue のテンプレートへ直書きせず定数として補間する(直書きすると Vue が式として評価する)。
 */
export const FUND_IMAGE_WARNING_MESSAGE =
  '値入り HTML の画像参照に {{ fund.code }} が残っています。' +
  '外部ツールで確定したパスを書いてください。PDF には表示されません';

const PREFIX = `${FUND_IMAGES_DIR}/`;
const FUND_CODE_EXPR_RE = /\{\{\s*fund\.code\s*\}\}/g;
/** 解いた後にも残る Jinja の開始記号(式・文・コメント)。 */
const JINJA_RE = /\{[{%#]/;

/** テンプレ ID(`<会社>_<ファンド>_<基準日>_<版>`)からファンドコードを取り出す。 */
export function fundCodeOfTemplateId(templateId: string): string | null {
  return parseTemplateFileName(`${templateId}.html`)?.fundCode ?? null;
}

/** `src` が差す対象なら、配信するファイル名を返す。対象外は null。 */
export function resolveFundImageSrc(src: string, ctx: FundImageContext): string | null {
  if (!src.startsWith(PREFIX)) return null;
  let resolved = src;
  if (ctx.mode === 'jinja') {
    const { fundCode } = ctx;
    if (fundCode === null) return null;
    // 置換文字列に `$` を含むファンドコードでも置換記法として読ませない。
    resolved = resolved.replace(FUND_CODE_EXPR_RE, () => fundCode);
  }
  if (JINJA_RE.test(resolved)) return null;
  return fundImageFileOf(resolved) ?? null;
}

/** 値入り本文に、解けない(`{{` の残る)images/ 参照があるか。 */
export function needsFundImageWarning(srcs: Iterable<string>, ctx: FundImageContext): boolean {
  if (ctx.mode !== 'filled') return false;
  for (const src of srcs) {
    if (src.startsWith(PREFIX) && src.includes('{{')) return true;
  }
  return false;
}

/**
 * CSS の二重引用符文字列にする。`"` `\` はエスケープし、制御文字と `<` `>` は 16 進エスケープ
 * にする(`<style>` の中身として直列化される場面でも要素を閉じる字面を作らない)。
 */
export function cssString(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (cp < 0x20 || cp === 0x7f || ch === '<' || ch === '>') out += `\\${cp.toString(16)} `;
    else out += ch;
  }
  return `"${out}"`;
}

/** canvas の `<img>` の `src` 一覧から、差し替えの CSS と先読みする URL を作る(重複は 1 つ)。 */
export function fundImageCss(
  srcs: Iterable<string>,
  ctx: FundImageContext,
): { css: string; urls: string[] } {
  const rules: string[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const src of srcs) {
    if (seen.has(src)) continue;
    seen.add(src);
    const file = resolveFundImageSrc(src, ctx);
    if (file === null) continue;
    const url = fundImageUrl(file);
    rules.push(`img[src=${cssString(src)}]{content:url(${cssString(url)})}`);
    if (!urls.includes(url)) urls.push(url);
  }
  return { css: rules.join('\n'), urls };
}
```

`vitest.config.ts` の coverage include で `'editor/web/src/features/editor/pageView.ts',` の直後に追加:

```ts
        // 編集画面のファンド別画像。属性を書き換えず CSS で差す設計の純粋部分と GrapesJS 配線。
        'editor/web/src/features/editor/fundImages.ts',
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm --filter web exec vitest run test/fundImages.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/fundImages.ts editor/web/test/fundImages.test.ts
git add editor/web/src/features/editor/fundImages.ts editor/web/test/fundImages.test.ts vitest.config.ts
git commit -m "feat(web): 編集画面でファンド別画像を差す対象とファンドコードの解決、差し替え CSS の生成を純関数で用意する"
```

---

### Task 7: 編集画面の canvas に画像を CSS で差し、代替画像処理を止め、値入り本文の警告を出す

**Files:**
- Create: `editor/web/src/features/editor/fundImageLayer.ts`
- Create: `editor/web/test/fundImageLayer.dom.test.ts`
- Modify: `editor/web/src/features/editor/useGrapes.ts`（import、状態、`init` の `registerJinjaComponents(ed);` の直後、`destroy`、戻り値）
- Modify: `editor/web/src/features/editor/useTemplateEditor.ts`（import、`onMounted` の `g.init(...)` の直後、戻り値）
- Modify: `editor/web/src/features/editor/EditorView.vue`（import、`useTemplateEditor` の分割代入、ペア同期の競合バナーの直後）
- Modify: `vitest.config.ts`（Task 6 で足した行の直後）

**Interfaces:**
- Consumes: `FundImageContext`・`fundImageCss`・`needsFundImageWarning`・`resolveFundImageSrc`・`fundCodeOfTemplateId`・`FUND_IMAGE_WARNING_MESSAGE`（Task 6）
- Produces:
  - `export const FUND_IMAGE_STYLE_ATTR = 'data-fund-images'`
  - `export type FundImageHost = Pick<Editor, 'on' | 'Canvas'>`
  - `export interface FundImageLayerOptions { getContext: () => FundImageContext; onImagesReady: () => void; onWarningChange: (on: boolean) => void; preload?: (url: string) => Promise<void>; schedule?: (cb: () => void) => void }`
  - `export interface FundImageLayer { refresh(): void }`
  - `export function attachFundImages(host: FundImageHost, opts: FundImageLayerOptions): FundImageLayer`
  - `export function registerFundImageView(ed: Editor, isTarget: (src: string) => boolean): void`
  - `useGrapes()` の戻り値に `fundImageWarning: Ref<boolean>`・`setFundImageContext(ctx: FundImageContext): void`
  - `useTemplateEditor()` の戻り値に `fundImageWarning`

- [ ] **Step 1: 失敗するテストを書く**

`editor/web/test/fundImageLayer.dom.test.ts`:

```ts
// =============================================================================
// fundImageLayer.dom.test.ts — 編集画面のファンド別画像(CSS で差す・保存内容を変えない)
// =============================================================================
// 主張は 3 つ。
//   1. canvas の `<img>` を走査して、対象にだけ `content:url()` の規則を書く(属性は触らない)。
//   2. 文字編集の取り込み直し・ペーストを経ても、保存出力(getBodyHtml → toTemplate)は原文の
//      `src` のままで、配信 URL が混ざらない。
//   3. GrapesJS の代替画像処理(onError で src を差し替える)が対象の `src` で止まる。
import type { Component } from 'grapesjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachFundImages,
  FUND_IMAGE_STYLE_ATTR,
  type FundImageHost,
} from '@/features/editor/fundImageLayer';
import { cssString, type FundImageContext } from '@/features/editor/fundImages';
import { useGrapes } from '@/features/editor/useGrapes';
import { toTemplate } from '@/lib/jinjaMask';

const JINJA: FundImageContext = { mode: 'jinja', fundCode: '510037' };
const FILLED: FundImageContext = { mode: 'filled', fundCode: '510037' };

/** `on` で張られた handler を名前で呼べる最小の editor。canvas の document は jsdom のもの。 */
function fakeHost(doc: Document) {
  const handlers = new Map<string, Array<() => void>>();
  const host = {
    on: (event: string, cb: () => void) => {
      for (const e of event.split(' ')) handlers.set(e, [...(handlers.get(e) ?? []), cb]);
    },
    Canvas: { getDocument: () => doc },
  } as unknown as FundImageHost;
  const emit = (event: string) => {
    for (const cb of handlers.get(event) ?? []) cb();
  };
  return { host, emit };
}

const styleText = (): string =>
  document.head.querySelector(`style[${FUND_IMAGE_STYLE_ATTR}]`)?.textContent ?? '';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('attachFundImages', () => {
  it('Jinja 本文: 対象の <img> にだけ規則を書き、先読み後に再計測を呼ぶ', async () => {
    document.body.innerHTML =
      '<img src="images/{{ fund.code }}_logo.svg"><img src="images/510037_seal.png">' +
      '<img src="photos/x.png"><img src="images/{{ report.x }}.svg">';
    const { host, emit } = fakeHost(document);
    const preload = vi.fn(async () => {});
    const onImagesReady = vi.fn();
    attachFundImages(host, {
      getContext: () => JINJA,
      onImagesReady,
      onWarningChange: vi.fn(),
      preload,
      schedule: (cb) => cb(),
    });
    emit('load');
    const css = styleText();
    expect(css).toContain(
      'img[src="images/{{ fund.code }}_logo.svg"]{content:url("/api/fund-assets/images/510037_logo.svg")}',
    );
    expect(css).toContain('/api/fund-assets/images/510037_seal.png');
    expect(css).not.toContain('photos');
    expect(css).not.toContain('report');
    expect(preload.mock.calls.map(([u]) => u).sort()).toEqual([
      '/api/fund-assets/images/510037_logo.svg',
      '/api/fund-assets/images/510037_seal.png',
    ]);
    await vi.waitFor(() => expect(onImagesReady).toHaveBeenCalledTimes(1));
    // 属性は 1 つも書き換えていない。
    expect(document.body.innerHTML).not.toContain('fund-assets');
  });

  it('値入り本文: {{ の残る参照は差さずに警告し、消えたら警告を下ろす', () => {
    document.body.innerHTML =
      '<img id="bad" src="images/{{ fund.code }}_logo.svg"><img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const onWarningChange = vi.fn();
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange,
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    emit('load');
    expect(onWarningChange).toHaveBeenLastCalledWith(true);
    expect(styleText()).not.toContain('{{');
    expect(styleText()).toContain('img[src="images/510037_logo.svg"]');
    document.getElementById('bad')?.remove();
    emit('component:remove');
    expect(onWarningChange).toHaveBeenLastCalledWith(false);
  });

  it('同じ内容では style を書き直さず、同じ URL は 1 度しか先読みしない', () => {
    document.body.innerHTML = '<img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const preload = vi.fn(async () => {});
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange: vi.fn(),
      preload,
      schedule: (cb) => cb(),
    });
    emit('load');
    const el = document.head.querySelector(`style[${FUND_IMAGE_STYLE_ATTR}]`);
    emit('component:update');
    emit('component:add');
    expect(document.head.querySelector(`style[${FUND_IMAGE_STYLE_ATTR}]`)).toBe(el);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('canvas の document が作り直されたら style を作り直す', () => {
    document.body.innerHTML = '<img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    const layer = attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange: vi.fn(),
      preload: async () => {},
      schedule: (cb) => cb(),
    });
    emit('load');
    document.head.innerHTML = '';
    layer.refresh();
    expect(styleText()).toContain('img[src="images/510037_logo.svg"]');
  });

  it('書いたセレクタは引用符・空白を含む src の <img> に実際に一致する', () => {
    const src = 'images/510037_a"b c.svg';
    const img = document.createElement('img');
    img.setAttribute('src', src);
    document.body.appendChild(img);
    expect(document.querySelectorAll(`img[src=${cssString(src)}]`)).toHaveLength(1);
  });

  it('先読みの既定実装(Image)でも落ちない', () => {
    document.body.innerHTML = '<img src="images/510037_logo.svg">';
    const { host, emit } = fakeHost(document);
    attachFundImages(host, {
      getContext: () => FILLED,
      onImagesReady: vi.fn(),
      onWarningChange: vi.fn(),
    });
    expect(() => emit('load')).not.toThrow();
  });
});

/** class でモデル木を探す(`saveFormat.dom.test.ts` と同じ理由で view 依存の find を避ける)。 */
function findByClass(root: Component, cls: string): Component | undefined {
  if (root.getClasses().includes(cls)) return root;
  for (const child of root.components()) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

describe('useGrapes との結合', () => {
  let g: ReturnType<typeof useGrapes>;
  beforeEach(() => {
    g = useGrapes();
    g.init({ canvas: document.createElement('div'), layers: document.createElement('div') });
    g.setFundImageContext(JINJA);
  });

  it('文字編集の取り込み直し・ペーストの後も、保存出力は原文の src のまま', () => {
    g.load(
      '<div class="page"><p class="t">見出し<img src="images/{{ fund.code }}_logo.svg" alt=""></p></div>',
      '',
    );
    const wrapper = g.editor.value?.getWrapper();
    const p = wrapper ? findByClass(wrapper, 't') : undefined;
    expect(p).toBeDefined();
    // RTE の終了時と同じく、編集後の innerHTML でテキスト component の中身を作り直す。
    p?.components('見出し改<img src="images/{{ fund.code }}_logo.svg" alt="">');
    // ペースト相当(兄弟へ HTML を足す)。
    p?.parent()?.append('<img src="images/510037_seal.png">');
    const saved = toTemplate(g.getBodyHtml(), { asFragment: true });
    expect(saved).toContain('src="images/{{ fund.code }}_logo.svg"');
    expect(saved).toContain('src="images/510037_seal.png"');
    expect(saved).not.toContain('fund-assets');
    expect(g.getCss()).not.toContain('fund-assets');
  });

  it('代替画像処理は対象の src で止まり、対象外では従来どおり差し替える', () => {
    const View = g.editor.value?.DomComponents.getType('image')?.view as unknown as {
      prototype: { onError(this: unknown): void };
    };
    const fake = (src: string) => ({
      model: {
        get: (key: string) => (key === 'src' ? src : undefined),
        getSrcResult: () => 'data:image/svg+xml;base64,FALLBACK',
      },
      el: { src, srcset: '' },
    });
    const target = fake('images/{{ fund.code }}_logo.svg');
    View.prototype.onError.call(target);
    expect(target.el.src).toBe('images/{{ fund.code }}_logo.svg');
    const other = fake('photos/x.png');
    View.prototype.onError.call(other);
    expect(other.el.src).toBe('data:image/svg+xml;base64,FALLBACK');
  });

  it('値入り本文へ切り替えると {{ の残る src は対象から外れる', () => {
    g.setFundImageContext(FILLED);
    const View = g.editor.value?.DomComponents.getType('image')?.view as unknown as {
      prototype: { onError(this: unknown): void };
    };
    const t = {
      model: {
        get: (key: string) => (key === 'src' ? 'images/{{ fund.code }}_logo.svg' : undefined),
        getSrcResult: () => 'data:image/svg+xml;base64,FALLBACK',
      },
      el: { src: 'images/{{ fund.code }}_logo.svg', srcset: '' },
    };
    View.prototype.onError.call(t);
    expect(t.el.src).toBe('data:image/svg+xml;base64,FALLBACK');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm --filter web exec vitest run test/fundImageLayer.dom.test.ts`
Expected: FAIL（`@/features/editor/fundImageLayer` が無い、`g.setFundImageContext` が無い）

- [ ] **Step 3: `fundImageLayer.ts` を実装する**

`editor/web/src/features/editor/fundImageLayer.ts`:

```ts
// =============================================================================
// fundImageLayer.ts — 編集画面の canvas にファンド別画像を CSS で差す(GrapesJS への配線)
// =============================================================================
// 何を差すかの判断は `fundImages.ts`(純関数)が持ち、ここは canvas の DOM を走査して canvas
// 専用の `<style>` を書き直すだけ。属性もモデルも触らないので、保存内容(getHtml/getCss)には
// 何も載らない。GrapesJS の image component にならない `<img>`(Jinja のブロックにまとめた
// 範囲の中など)も、DOM の走査なので同じ規則で表示される。
//
// `content:url()` の画像は `load` イベントを出さないので、ページ境界・幾何の再計測は、規則を
// 作り直したあとの画像の読み込み完了(`Image` で同じ URL を先読みして `decode()` を待つ)を
// 契機にする。

import type { Editor } from 'grapesjs';
import { type FundImageContext, fundImageCss, needsFundImageWarning } from './fundImages';

/** canvas の head に置く差し替え用 `<style>` の目印。 */
export const FUND_IMAGE_STYLE_ATTR = 'data-fund-images';

/** このモジュールが editor に求める面(テストで最小の偽物を渡せるよう絞る)。 */
export type FundImageHost = Pick<Editor, 'on' | 'Canvas'>;

export interface FundImageLayerOptions {
  /** 現在の本文の種類とファンドコード(読み込みのたびに変わりうるので関数で受ける)。 */
  getContext: () => FundImageContext;
  /** 差した画像の読み込みが済んだ(ページ境界・幾何を測り直す契機)。 */
  onImagesReady: () => void;
  /** 値入り本文の解けない参照の有無が変わった。 */
  onWarningChange: (on: boolean) => void;
  /** 画像の先読み(テストで差し替える)。既定は `Image` + `decode()`。 */
  preload?: (url: string) => Promise<void>;
  /** 走査の間引き(テストで同期にする)。既定は rAF で 1 フレーム 1 回。 */
  schedule?: (cb: () => void) => void;
}

export interface FundImageLayer {
  /** canvas を走査して規則と警告を作り直す。 */
  refresh(): void;
}

function defaultPreload(url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  return typeof img.decode === 'function' ? img.decode() : Promise.resolve();
}

/**
 * canvas にファンド別画像の差し替え層を張る。走査の契機は読み込み時と、component の追加・
 * 削除・更新(属性変更を含む)の後。テキスト入力中は高頻度で発火するので 1 フレームへ集約する。
 */
export function attachFundImages(host: FundImageHost, opts: FundImageLayerOptions): FundImageLayer {
  const preload = opts.preload ?? defaultPreload;
  const schedule = opts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
  let styleEl: HTMLStyleElement | null = null;
  let lastCss = '';
  let lastWarning = false;
  let pending = false;
  /** この document で先読みを始めた URL(document が変われば数え直す)。 */
  const preloaded = new Set<string>();

  const ensureStyle = (doc: Document): HTMLStyleElement => {
    if (styleEl?.isConnected && styleEl.ownerDocument === doc) return styleEl;
    styleEl = doc.createElement('style');
    styleEl.setAttribute(FUND_IMAGE_STYLE_ATTR, '');
    doc.head.appendChild(styleEl);
    lastCss = '';
    preloaded.clear();
    return styleEl;
  };

  const refresh = (): void => {
    const doc = host.Canvas.getDocument();
    if (!doc?.head) return;
    const srcs = Array.from(doc.querySelectorAll('img'), (img) => img.getAttribute('src') ?? '');
    const ctx = opts.getContext();
    const { css, urls } = fundImageCss(srcs, ctx);
    const el = ensureStyle(doc);
    // 同じ内容なら書き直さない(書き直すと no-store の画像を取り直して表示がちらつく)。
    if (css !== lastCss) {
      el.textContent = css;
      lastCss = css;
    }
    const fresh = urls.filter((u) => !preloaded.has(u));
    for (const u of fresh) preloaded.add(u);
    if (fresh.length > 0) {
      void Promise.allSettled(fresh.map((u) => preload(u))).then(() => opts.onImagesReady());
    }
    const warning = needsFundImageWarning(srcs, ctx);
    if (warning !== lastWarning) {
      lastWarning = warning;
      opts.onWarningChange(warning);
    }
  };

  const scheduleRefresh = (): void => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      refresh();
    });
  };

  host.on('load', refresh);
  host.on('canvas:frame:load', refresh);
  host.on('component:add', scheduleRefresh);
  host.on('component:remove', scheduleRefresh);
  host.on('component:update', scheduleRefresh);
  return { refresh };
}

/** GrapesJS の image view の、ここで使う面だけ。 */
interface ImageViewLike {
  model: { get(key: string): unknown };
}

/**
 * image の view を拡張し、差し替え対象の `src` では読み込み失敗時の代替画像処理(`onError` で
 * `el.src` を差し替える)を止める。差し替わると `img[src="…"]` のセレクタが外れて画像が出ない。
 * component の生成より前(`init` の中)で呼ぶこと。
 */
export function registerFundImageView(ed: Editor, isTarget: (src: string) => boolean): void {
  const dc = ed.DomComponents;
  const base = dc.getType('image')?.view as unknown as
    | { prototype: { onError(this: ImageViewLike): void } }
    | undefined;
  if (base === undefined) return;
  const view = {
    onError(this: ImageViewLike): void {
      const src = this.model.get('src');
      if (typeof src === 'string' && isTarget(src)) return;
      base.prototype.onError.call(this);
    },
  };
  dc.addType('image', { view } as unknown as Parameters<typeof dc.addType>[1]);
}
```

- [ ] **Step 4: `useGrapes.ts` に配線する**

import に追加:

```ts
import { attachFundImages, type FundImageLayer, registerFundImageView } from './fundImageLayer';
import { type FundImageContext, resolveFundImageSrc } from './fundImages';
```

`let varsHighlight = false;` の直後に追加:

```ts

  // ファンド別画像の文脈(本文の種類とファンドコード)。`setFundImageContext` が差し替え、
  // 差し替え層(`fundImageLayer.ts`)と image view の拡張が読む。
  let fundImageContext: FundImageContext = { mode: 'filled', fundCode: null };
  let fundImages: FundImageLayer | null = null;
  /** 値入り本文に `{{ … }}` 入りの画像参照が残っているか(編集画面の警告用)。 */
  const fundImageWarning = ref(false);
```

`init` の `registerJinjaComponents(ed);` の直後に追加:

```ts

    // ファンド別画像は属性を書き換えず、canvas 専用の `<style>` で差す(`fundImageLayer.ts`)。
    // 対象の `<img>` で GrapesJS の代替画像処理が `src` を差し替えるとセレクタが外れるので、
    // view の拡張は component 生成より前のここで行う。
    registerFundImageView(ed, (src) => resolveFundImageSrc(src, fundImageContext) !== null);
    fundImages = attachFundImages(ed, {
      getContext: () => fundImageContext,
      onImagesReady: scheduleLayoutRecompute,
      onWarningChange: (on) => {
        fundImageWarning.value = on;
      },
    });
```

`setVarsHighlight` の直後に追加:

```ts
  /**
   * 編集画面のファンド別画像の文脈を設定する。`load` より前に呼ぶ(呼んだ時点の canvas も
   * 作り直す)。Jinja 本文は `{{ fund.code }}` を解き、値入り本文は確定パスだけを差す。
   */
  function setFundImageContext(ctx: FundImageContext): void {
    fundImageContext = ctx;
    fundImages?.refresh();
  }
```

`destroy` の `editor.value?.destroy();` の直前に `fundImages = null;` を足す。戻り値の `setVarsHighlight,` の直後に `setFundImageContext,` と `fundImageWarning,` を足す。

- [ ] **Step 5: `useTemplateEditor.ts` と `EditorView.vue` に配線する**

`useTemplateEditor.ts` の import に追加:

```ts
import { fundCodeOfTemplateId } from './fundImages';
```

`onMounted` の `g.init({ canvas, layers });` の直後に追加:

```ts
    // ファンド別画像の文脈。値入り本文(`filled` が非空 = 編集タブの本文)は描画を通らないので
    // 確定パスだけを差し、Jinja 本文は `{{ fund.code }}` をテンプレ ID のファンドコードで解く。
    // 判定をプレビュー(`templatePreviewService` の `isFilled`)と同じ材料にして、編集画面だけ
    // 見える / 見えないのずれを作らない。
    g.setFundImageContext({
      mode: res.value.template.filled ? 'filled' : 'jinja',
      fundCode: fundCodeOfTemplateId(id),
    });
```

戻り値の `syncStatus,` の直後に `fundImageWarning: g.fundImageWarning,` を足す。

`EditorView.vue` の `<script setup>` の import に `import { FUND_IMAGE_WARNING_MESSAGE } from './fundImages';` を足し、`useTemplateEditor` の分割代入の `syncStatus,` の直後に `fundImageWarning,` を足す。ペア同期の競合バナー（`v-if="syncStatus && syncStatus.conflicts.length > 0"` の `</div>`）の直後に追加:

```vue

    <!-- 値入り本文に {{ fund.code }} 入りの画像参照が残っている。PDF にもプレビューにも出ないので、
         外部ツール側で確定パスへ直すまで開くたびに出す(閉じるボタンは置かない)。文言は
         テンプレート構文の字面を含むため定数で補間する。 -->
    <div
      v-if="fundImageWarning"
      class="flex items-center gap-2 border-b bg-warning/15 px-4 py-1.5 text-[12.5px] text-warning-foreground"
      role="alert"
    >
      <TriangleAlert class="h-4 w-4 shrink-0" />
      <span>{{ FUND_IMAGE_WARNING_MESSAGE }}</span>
    </div>
```

`vitest.config.ts` の coverage include で Task 6 で足した `'editor/web/src/features/editor/fundImages.ts',` の直後に追加:

```ts
        'editor/web/src/features/editor/fundImageLayer.ts',
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `pnpm --filter web exec vitest run test/fundImageLayer.dom.test.ts test/fundImages.test.ts test/saveFormat.dom.test.ts test/canvasActiveContent.guard.dom.test.ts test/twoSystems.guard.test.ts`
Expected: PASS。`p?.components(...)` が GrapesJS の版で `resetFromString` を要する場合は、`p?.components().resetFromString('…')` に置き換える（主張は同じ）。

Run: `pnpm typecheck:editor`
Expected: エラー 0。`dc.addType` の型が合わない場合も、`as unknown as Parameters<typeof dc.addType>[1]` のまま通ることを確かめる（view の中身は GrapesJS の拡張機構が実行時に解釈する）。

- [ ] **Step 7: 実機で確かめる（任意だが推奨）**

`start.bat` で dev 起動し、`images/510037_logo.svg`（`width` / `height` 付き）を置いた dataRoot で、作成経路（`?created=1`）と編集経路の両方を開く。画像が出ること、`{{ fund.code }}` を残した値入り HTML で警告バナーが出ること、文字編集の後の下書き（`drafts/<id>.html`）に `/api/fund-assets` が無いことを目視する。

- [ ] **Step 8: コミット**

```bash
pnpm exec biome check --write editor/web/src/features/editor/fundImageLayer.ts editor/web/src/features/editor/useGrapes.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/src/features/editor/EditorView.vue editor/web/test/fundImageLayer.dom.test.ts
git add editor/web/src/features/editor/fundImageLayer.ts editor/web/src/features/editor/useGrapes.ts editor/web/src/features/editor/useTemplateEditor.ts editor/web/src/features/editor/EditorView.vue editor/web/test/fundImageLayer.dom.test.ts vitest.config.ts
git commit -m "feat(web): 編集画面のファンド別画像を canvas 専用の CSS で差し、代替画像処理を止め、値入り本文の未解決参照を警告する"
```

---

### Task 8: 既存環境向けパッチ（2026-10-fund-images）

**Files:**
- Create: `editor/patches/2026-10-fund-images/apply.ps1`（UTF-8 BOM）
- Create: `editor/patches/2026-10-fund-images/apply.bat`（CRLF）
- Create: `editor/patches/2026-10-fund-images/rollback.ps1`（UTF-8 BOM）
- Create: `editor/patches/2026-10-fund-images/rollback.bat`（CRLF）
- Create: `editor/patches/2026-10-fund-images/README.md`
- Test: `editor/patches/2026-10-fund-images/apply.Tests.ps1`（UTF-8 BOM。Pester 3/4 書式）
- Modify: ルート `README.md`（入口スクリプト一覧の `2026-10-fonts-to-css/rollback.bat` の行の直後に 2 行）

**Interfaces:**
- Produces: `apply.bat [-DataRoot <path>] [-Apply] [-Port <n>]`、`rollback.bat [-DataRoot <path>] [-Apply]`。移行コミットの件名末尾の目印 `[fund-images]`。報告の ASCII タグ `[subfolder]` `[extension]` `[naming]`。

- [ ] **Step 1: 失敗するテストを書く**

`apply.Tests.ps1`:

```powershell
# apply.ps1 / rollback.ps1 の Pester 3/4 テスト。①の移行済みの dataRoot を一時フォルダに作り、
# 確認モード・適用・再実行・.gitignore だけの未コミット・中止条件・点検の報告・rollback を確かめる。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'apply.ps1'
$roll = Join-Path $here 'rollback.ps1'

# 実データへ触れないよう、置き場に効く環境変数を退避して空にし、APP_CONFIG を存在しない
# パスへ向けて実行する。-DataRoot と -Port 1 は呼び出し側が必ず渡す。
function Invoke-Patch([string]$file, [hashtable]$params, [string]$imagesDir) {
  $names = 'APP_CONFIG', 'DATA_ROOT', 'IMAGES_DIR'
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  [Environment]::SetEnvironmentVariable('APP_CONFIG', (Join-Path $env:TEMP 'fund-img-no-appconfig.json'))
  if ($imagesDir) { [Environment]::SetEnvironmentVariable('IMAGES_DIR', $imagesDir) }
  try { & $file @params }
  finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}

function New-Layout([switch]$WithAssets) {
  $root = Join-Path $env:TEMP ('fund-img-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  foreach ($d in 'css', 'templates', 'filled') { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
  Set-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value '.a{}' -NoNewline
  if ($WithAssets) { New-Item -ItemType Directory -Force -Path (Join-Path $root 'assets\fonts') | Out-Null }
  [IO.File]::WriteAllText((Join-Path $root '.gitignore'),
    "/drafts/`n/reviews/`n/pending/`n/notes/`n/css/fonts/`n*.tmp-*`n", (New-Object Text.UTF8Encoding $false))
  git -C $root init -q
  git -C $root add -- .gitignore css
  git -C $root -c user.name=t -c user.email=t@t commit -q -m init
  return $root
}

function Get-IgnoreLines([string]$root) { @([IO.File]::ReadAllLines((Join-Path $root '.gitignore'))) }

Describe 'apply.ps1' {
  It '確認モードでは何も変えない' {
    $root = New-Layout
    try {
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $script @{ DataRoot = $root; Port = 1 } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
      Test-Path (Join-Path $root 'images') | Should Be $false
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '-Apply で .gitignore に /images/ を足し、images を作り、system 名義で 1 コミットする' {
    $root = New-Layout
    try {
      $before = @(git -C $root rev-list HEAD).Count
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $true
      Test-Path (Join-Path $root 'images') | Should Be $true
      @(git -C $root rev-list HEAD).Count | Should Be ($before + 1)
      # 件名の日本語は PowerShell 5.1 が git の出力を OEM コードページで読むため化ける。
      # 照合は ASCII の目印と作者名で行う。
      (git -C $root log -1 --format='%an') | Should Be 'system'
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      (git -C $root status --porcelain -- .gitignore css templates filled sync) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '再実行しても何も変えない' {
    $root = New-Layout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '.gitignore に /images/ だけが未コミットで足されていれば進み、その差分をコミットする' {
    $root = New-Layout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/images/`n", (New-Object Text.UTF8Encoding $false))
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      (git -C $root show --name-only --format= HEAD) | Should Be '.gitignore'
      (git -C $root log -1 --format='%s') | Should Match '\[fund-images\]'
      (git -C $root status --porcelain -- .gitignore) | Should BeNullOrEmpty
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '.gitignore に /images/ 以外の行も足されていれば中止する' {
    $root = New-Layout
    try {
      [IO.File]::AppendAllText((Join-Path $root '.gitignore'), "/images/`n/other/`n", (New-Object Text.UTF8Encoding $false))
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } } | Should Throw
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'それ以外の未コミット変更があれば中止する' {
    $root = New-Layout
    try {
      Add-Content -LiteralPath (Join-Path $root 'css\510037.css') -Value ' '
      $head = git -C $root rev-parse HEAD
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } } | Should Throw
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '①の移行前(assets が残っている)なら①のパッチを案内して中止する' {
    $root = New-Layout -WithAssets
    try {
      $msg = ''
      try { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null } catch { $msg = $_.Exception.Message }
      $msg | Should Match '2026-10-fonts-to-css'
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'imagesDir が確定領域の内側なら中止する' {
    $root = New-Layout
    try {
      $head = git -C $root rev-parse HEAD
      { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } (Join-Path $root 'css\images') } | Should Throw
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '既に置かれた画像を点検して報告する(書き換えない)' {
    $root = New-Layout
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $root 'images\sub') | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\sub\510037_a.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_anim.gif') -Value 'GIF' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\logo.svg') -Value '<svg/>' -NoNewline
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      $out = Invoke-Patch $script @{ DataRoot = $root; Port = 1 } *>&1 | Out-String
      $out | Should Match '\[subfolder\][^\r\n]*510037_a\.svg'
      $out | Should Match '\[extension\][^\r\n]*510037_anim\.gif'
      $out | Should Match '\[naming\][^\r\n]*logo\.svg'
      $out | Should Not Match '\[naming\][^\r\n]*510037_logo\.svg'
      Test-Path (Join-Path $root 'images\sub\510037_a.svg') | Should Be $true
    } finally { Remove-Item -Recurse -Force $root }
  }

  It 'git が失敗したら stderr の原因を例外に含める' {
    $root = New-Layout
    try {
      Set-Content -LiteralPath (Join-Path $root '.git\index.lock') -Value '' -NoNewline
      $msg = ''
      try { Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null } catch { $msg = $_.Exception.Message }
      $msg | Should Match 'index\.lock'
    } finally { Remove-Item -Recurse -Force $root }
  }
}

Describe 'rollback.ps1' {
  It '2 回流しても revert の revert にならず、images の中身は残る' {
    $root = New-Layout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      Set-Content -LiteralPath (Join-Path $root 'images\510037_logo.svg') -Value '<svg/>' -NoNewline
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
      Test-Path (Join-Path $root 'images\510037_logo.svg') | Should Be $true
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $roll @{ DataRoot = $root; Apply = $true } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
      (Get-IgnoreLines $root) -contains '/images/' | Should Be $false
    } finally { Remove-Item -Recurse -Force $root }
  }

  It '確認モードでは何も変えない' {
    $root = New-Layout
    try {
      Invoke-Patch $script @{ DataRoot = $root; Apply = $true; Port = 1 } | Out-Null
      $head = git -C $root rev-parse HEAD
      Invoke-Patch $roll @{ DataRoot = $root } | Out-Null
      git -C $root rev-parse HEAD | Should Be $head
    } finally { Remove-Item -Recurse -Force $root }
  }
}
```

（`-Port 1` は「サーバ稼働中」判定を無害なポートへ向けるため。テスト中に TCP 1 番を誰も待ち受けていない前提。）

- [ ] **Step 2: テストが失敗することを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fund-images/apply.Tests.ps1"`
Expected: FAIL（`apply.ps1` が無い）

- [ ] **Step 3: apply.ps1 を実装する**

`apply.ps1`:

```powershell
<#
.SYNOPSIS
  editor の data リポジトリに、ファンド別画像の置き場(images)を用意する。

.DESCRIPTION
  既定は確認モードで、置き場の解決結果・行う変更・既に置かれた画像の点検結果を表示するだけで
  何も変えない。-Apply を付けたときだけ実行する。処理順:
    1. .gitignore に /images/ が無ければ追記する(画像を置く前に git の追跡外にしておく)
    2. <imagesDir> が無ければ作る
    3. .gitignore の変更を system 名義で 1 コミットする(件名末尾に [fund-images])
  既に置かれた画像は点検して報告するだけで、動かしも消しもしない。SVG の中身の検査はサーバ
  (TypeScript 実装)が正なので、ここでは行わない。違反はサーバログの警告で確認する。
  次の場合は中止する: editor サーバが動いている、dataRoot が git リポジトリでない、旧構成の
  assets が残っている(先に 2026-10-fonts-to-css を流す)、imagesDir が確定領域(templates /
  filled / css / sync)の内側にある、確定領域に未コミットの変更がある。
  ただし未コミットの変更が「.gitignore に /images/ の 1 行が追記されただけ」のときは中止せず、
  その差分をコミットに含める(新版のサーバが承認時に先に追記した場合)。

.PARAMETER DataRoot
  data リポジトリの場所。省略時は -DataRoot → 環境変数 DATA_ROOT(プロセス → ユーザー) →
  appconfig の paths.dataRoot → 既定の順で決める(2026-10-fonts-to-css と同じ規則)。

.PARAMETER Apply
  実際に変更する。付けなければ確認モード。

.PARAMETER Port
  稼働確認に使う editor サーバのポート(既定 24680)。

.EXAMPLE
  editor\patches\2026-10-fund-images\apply.bat
  確認モードで、何が変わるかと、置かれた画像の点検結果を表示する。

.EXAMPLE
  editor\patches\2026-10-fund-images\apply.bat -Apply
  置き場を用意する(サーバを止めてから)。
#>
param(
  [string]$DataRoot,
  [switch]$Apply,
  [int]$Port = 24680
)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$confirmedAreas = 'templates', 'filled', 'css', 'sync'
$allowedExt = '.svg', '.png', '.jpg', '.jpeg'

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

function Invoke-Git {
  # git は LF→CRLF 変換などの警告を stderr へ出す。$ErrorActionPreference = 'Stop' のままだと
  # PowerShell 5.1 がそれを例外にするので、stderr は自前で受けて終了コードで失敗を判定する。
  # 成功時の警告は捨て、失敗時だけ原因として例外メッセージへ載せる。
  $ErrorActionPreference = 'Continue'
  $all = @(& git -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

function Test-TemplateToken([string]$s) {
  # shared/src/domain/template.ts の isValidTemplateToken と同じ規則の写し(パッチは TypeScript を
  # 呼べないため)。片方を変えたらもう片方も変える。
  if ($s.Length -eq 0 -or $s.Length -gt 200) { return $false }
  if ($s -match '[/\\:*?"<>|_]') { return $false }
  if ($s -match '[\x00-\x1f]') { return $false }
  if ($s.Contains('..')) { return $false }
  if ($s -ne $s.Trim() -or $s.EndsWith('.')) { return $false }
  if ($s -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$') { return $false }
  return $true
}

function Test-FundImageName([string]$name) {
  # 命名の約束 <fund>_<画像名>.<拡張子>。fund はファイル名規約の 1 トークン。
  $stem = [IO.Path]::GetFileNameWithoutExtension($name)
  $cut = $stem.IndexOf('_')
  if ($cut -le 0 -or $cut -eq $stem.Length - 1) { return $false }
  return (Test-TemplateToken $stem.Substring(0, $cut))
}

# ── 1. 置き場の解決(2026-10-fonts-to-css の migrate.ps1 と同じ規則。共通 lib は作らない) ──
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }

function Get-CfgPath([string]$key) {
  if ($cfgPaths -and $cfgPaths.PSObject.Properties[$key] -and $cfgPaths.$key) { return [string]$cfgPaths.$key }
  return $null
}

$source = '-DataRoot 引数'
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT; $source = '環境変数 DATA_ROOT'
  if (-not $DataRoot) {
    $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User'); $source = 'ユーザー環境変数 DATA_ROOT'
  }
  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot'; $source = 'appconfig の paths.dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data'; $source = '既定' }
}

# images は IMAGES_DIR → appconfig の paths.imagesDir → <dataRoot>\images(サーバの config.ts と同じ順)。
$imagesSource = '既定(dataRoot\images)'
$imagesDir = Join-Path $DataRoot 'images'
if ($env:IMAGES_DIR) { $imagesDir = Resolve-EditorPath $env:IMAGES_DIR; $imagesSource = '環境変数 IMAGES_DIR' }
elseif (Get-CfgPath 'imagesDir') {
  $imagesDir = Resolve-EditorPath (Get-CfgPath 'imagesDir'); $imagesSource = 'appconfig の paths.imagesDir'
}
$imagesFull = [IO.Path]::GetFullPath($imagesDir).TrimEnd('\')

Write-Host "dataRoot : $DataRoot ($source)"
Write-Host "imagesDir: $imagesFull ($imagesSource)"
Write-Host ("モード   : " + $(if ($Apply) { '適用(-Apply)' } else { '確認(何も変えません)' }))
Write-Host ''

# ── 2. 実行条件 ──
$listening = $false
try {
  $client = New-Object Net.Sockets.TcpClient
  $listening = $client.ConnectAsync('127.0.0.1', $Port).Wait(500)
  $client.Close()
} catch { $listening = $false }
if ($listening) { throw "editor サーバがポート $Port で動いています。停止してから実行してください。" }
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot '.git'))) { throw "$DataRoot は git リポジトリではありません。" }
if (Test-Path -LiteralPath (Join-Path $DataRoot 'assets')) {
  throw ("$DataRoot\assets が残っています。フォント置き場の移行が済んでいない(または元に戻した)環境です。" +
    "先に editor\patches\2026-10-fonts-to-css\migrate.bat を流してください。")
}
foreach ($a in $confirmedAreas) {
  $area = [IO.Path]::GetFullPath((Join-Path $DataRoot $a)).TrimEnd('\')
  if ($imagesFull -ieq $area -or $imagesFull.StartsWith($area + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw ("imagesDir($imagesFull)が確定領域 $a の内側にあります。画像が承認コミットへ巻き込まれるため" +
      "中止しました。環境変数 IMAGES_DIR / appconfig の paths.imagesDir を見直してください。")
  }
}

function Test-OnlyImagesLineAdded {
  # 新版のサーバ(gitRepo.ts の ensureGitignore)は承認時に足りない必須行を末尾へ足す。足したのが
  # /images/ の 1 行だけなら、それはこのパッチがする変更と同じなので取り込んで進める。
  $lines = @(Invoke-Git diff HEAD --unified=0 --no-color -- .gitignore)
  $changes = @($lines | Where-Object { $_ -match '^[+-]' -and $_ -notmatch '^(\+\+\+|---)( |$)' })
  return ($changes.Count -eq 1 -and $changes[0] -ceq '+/images/')
}

# 見るのは確定領域(承認コミットの対象)だけ。css/fonts は git 管理外の置き場なので除く。
$dirty = @(Invoke-Git status --porcelain -- .gitignore .gitattributes templates filled css sync ':(exclude)css/fonts')
$pendingIgnoreOnly = $false
if ($dirty.Count -gt 0) {
  if ($dirty.Count -eq 1 -and $dirty[0] -match '^[ M]{2} \.gitignore$' -and (Test-OnlyImagesLineAdded)) {
    $pendingIgnoreOnly = $true
  } else {
    throw ("dataRoot の git に未コミットの変更があります。先にコミットまたは破棄してください:`n" +
      ($dirty -join "`n"))
  }
}

# ── 3. 計画と点検 ──
$gitignorePath = Join-Path $DataRoot '.gitignore'
$ignoreLines = if (Test-Path -LiteralPath $gitignorePath) { @([IO.File]::ReadAllLines($gitignorePath) | ForEach-Object { $_.Trim() }) } else { @() }
$needsIgnore = -not ($ignoreLines -contains '/images/')
$needsDir = -not (Test-Path -LiteralPath $imagesFull)

$report = @()
if (-not $needsDir) {
  foreach ($f in Get-ChildItem -LiteralPath $imagesFull -Recurse -File) {
    if ($f.DirectoryName.TrimEnd('\') -ine $imagesFull) {
      $report += "[subfolder] $($f.FullName) (images 直下以外は配信されません)"; continue
    }
    if ($allowedExt -notcontains $f.Extension.ToLowerInvariant()) {
      $report += "[extension] $($f.FullName) (許可外の拡張子は配信されません。.svg .png .jpg .jpeg)"; continue
    }
    if (-not (Test-FundImageName $f.Name)) {
      $report += "[naming] $($f.FullName) (命名 <fund>_<名前>.<拡張子> に合いません。配信はされます)"
    }
  }
}

Write-Host ".gitignore に /images/ を追記: $needsIgnore"
if ($pendingIgnoreOnly) { Write-Host '  (/images/ の 1 行が未コミットで追記済みです。この差分をコミットします)' }
Write-Host "images フォルダを作成: $needsDir"
if ($report.Count -gt 0) {
  Write-Host "【報告】置かれている画像の点検($($report.Count) 件。書き換えません):"
  $report | ForEach-Object { Write-Host "  $_" }
}
Write-Host 'SVG の中身の検査はサーバが行います。違反した SVG は表示されず、サーバログに警告が出ます。'
if (-not $Apply) { Write-Host ''; Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 4. 適用 ──
if ($needsIgnore) {
  $current = if (Test-Path -LiteralPath $gitignorePath) { [IO.File]::ReadAllText($gitignorePath) } else { '' }
  if ($current -ne '' -and -not $current.EndsWith("`n")) { $current += "`n" }
  [IO.File]::WriteAllText($gitignorePath, $current + "/images/`n", $utf8NoBom)
}
if ($needsDir) { New-Item -ItemType Directory -Force -Path $imagesFull | Out-Null }
Invoke-Git add -- .gitignore | Out-Null
$staged = Invoke-Git diff --cached --name-only -- .gitignore
if ($staged) {
  # 末尾の [fund-images] は rollback.ps1 が git log --grep で探す ASCII の目印(日本語を
  # 引数で渡すと PowerShell 5.1 の文字コード変換で一致しなくなる)。
  Invoke-Git -c user.name=system -c user.email=system@editor.local commit -q -m '移行: 画像の置き場を追加 [fund-images]' -- .gitignore | Out-Null
  Write-Host '.gitignore の変更を system 名義でコミットしました。'
}
Write-Host '完了しました。editor を起動してください。'
```

`apply.bat` と `rollback.bat`（CRLF。`.claude/rules/powershell.md` の雛形）は Bash で書く:

```bash
printf '@echo off\r\nchcp 65001 >nul\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%%~dp0apply.ps1" %%*\r\nexit /b %%ERRORLEVEL%%\r\n' > editor/patches/2026-10-fund-images/apply.bat
printf '@echo off\r\nchcp 65001 >nul\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%%~dp0rollback.ps1" %%*\r\nexit /b %%ERRORLEVEL%%\r\n' > editor/patches/2026-10-fund-images/rollback.bat
```

- [ ] **Step 4: rollback.ps1 を実装する**

```powershell
<#
.SYNOPSIS
  2026-10-fund-images の変更(.gitignore の /images/)を元に戻す。

.DESCRIPTION
  既定は確認モード。-Apply を付けたときだけ実行する。目印 [fund-images] を持つ移行コミット
  (Revert で始まる件名は除く)を git revert する。すでに revert 済みなら何もしない。
  git revert が失敗したときは revert --abort で元の状態へ戻してから中止し、git の出力を表示する。
  images フォルダと中の画像は消さない(別ツールが置いた git 管理外のもので、戻せないため)。
  新版のサーバは承認時に /images/ を再び追記するので、戻す意味があるのはサーバも旧版へ戻す
  場合に限る。

.PARAMETER DataRoot
  data リポジトリの場所(省略時は apply.ps1 と同じ規則)。

.PARAMETER Apply
  実際に戻す。付けなければ確認モード。
#>
param([string]$DataRoot, [switch]$Apply)

$ErrorActionPreference = 'Stop'
$editorDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$workspace = Split-Path -Parent $editorDir

function Resolve-EditorPath([string]$p) {
  # サーバ(config.ts の toPath)は相対パスを editor/ 基準で解決するので合わせる。
  if ([IO.Path]::IsPathRooted($p)) { return $p }
  return [IO.Path]::GetFullPath((Join-Path $editorDir $p))
}

function Invoke-Git {
  # stderr の扱いは apply.ps1 と同じ(成功時の警告は捨て、失敗時だけ例外に載せる)。
  $ErrorActionPreference = 'Continue'
  $all = @(& git -C $DataRoot @args 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $err = ($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    throw "git $($args -join ' ') が失敗しました(終了コード $LASTEXITCODE)。`n$err"
  }
  return @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
}

# ── 1. 置き場の解決(apply.ps1 と同じ規則) ──
$appConfigPath = if ($env:APP_CONFIG) { $env:APP_CONFIG } else { Join-Path $editorDir 'appconfig.json' }
$appConfig = $null
if (Test-Path -LiteralPath $appConfigPath) {
  $appConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $appConfigPath | ConvertFrom-Json
}
$cfgPaths = if ($appConfig -and $appConfig.paths) { $appConfig.paths } else { $null }
function Get-CfgPath([string]$key) {
  if ($cfgPaths -and $cfgPaths.PSObject.Properties[$key] -and $cfgPaths.$key) { return [string]$cfgPaths.$key }
  return $null
}
if (-not $DataRoot) {
  $DataRoot = $env:DATA_ROOT
  if (-not $DataRoot) { $DataRoot = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User') }
  if (-not $DataRoot) { $DataRoot = Get-CfgPath 'dataRoot' }
  if ($DataRoot) { $DataRoot = Resolve-EditorPath $DataRoot }
  else { $DataRoot = Join-Path (Split-Path -Parent $workspace) 'editor-data' }
}
$imagesDir = if ($env:IMAGES_DIR) { Resolve-EditorPath $env:IMAGES_DIR }
  elseif (Get-CfgPath 'imagesDir') { Resolve-EditorPath (Get-CfgPath 'imagesDir') }
  else { Join-Path $DataRoot 'images' }

# ── 2. 戻す対象の特定 ──
# rollback 自身の revert コミットも件名に [fund-images] を含むので、Revert で始まる件名は除く。
# すでに revert 済み(This reverts commit <sha>)なら再 revert しない。
$commit = $null
foreach ($line in (Invoke-Git log --author=system --grep '\[fund-images\]' --format='%H %s')) {
  $sha, $subject = $line -split ' ', 2
  if ($subject -like 'Revert *') { continue }
  $commit = $sha
  break
}
$alreadyReverted = [bool]($commit -and (Invoke-Git log --grep "This reverts commit $commit" --format=%H -1))

Write-Host "dataRoot: $DataRoot"
if (-not $commit) { Write-Host 'revert するコミット: (なし)' }
elseif ($alreadyReverted) { Write-Host "revert するコミット: $commit(revert 済みのため飛ばします)" }
else { Write-Host "revert するコミット: $commit" }
Write-Host "images フォルダ($imagesDir)と中の画像は消しません。不要なら手で消してください。"
if (-not $Apply) { Write-Host '確認モードのため何も変えていません。実行するには -Apply を付けてください。'; return }

# ── 3. 適用 ──
if ($commit -and -not $alreadyReverted) {
  try {
    Invoke-Git -c user.name=system -c user.email=system@editor.local revert --no-edit $commit | Out-Null
  } catch {
    # 競合したまま止まると REVERTING 状態と競合マーカーが残るので、元の状態へ戻してから中止する。
    try { Invoke-Git revert --abort | Out-Null } catch { Write-Warning 'git revert --abort にも失敗しました。手動で確認してください。' }
    throw
  }
}
Write-Host '元に戻しました。サーバも旧版へ戻す場合だけ意味があります(新版は承認時に /images/ を再び追記します)。'
```

- [ ] **Step 5: BOM を付け、README を書く**

Run（Bash）:

```bash
for f in apply.ps1 rollback.ps1 apply.Tests.ps1; do p=editor/patches/2026-10-fund-images/$f; { printf '\xef\xbb\xbf'; cat "$p"; } > "$p.tmp" && mv "$p.tmp" "$p"; done
```

`editor/patches/2026-10-fund-images/README.md`（通常の日本語で）:

```markdown
# 2026-10-fund-images パッチ

editor の data リポジトリに、ファンド別画像の置き場 `images` を用意する一度きりのパッチです。
`.gitignore` に `/images/` を足して画像を git の記録対象から外し、`images` フォルダを作ります。

管理者が行う作業です。`.gitignore` の変更を承認なしで `system` 名義のコミットにします。

## 前提

- `2026-10-fonts-to-css` の移行が済んでいること。`<dataRoot>\assets` が残っている環境では中止し、
  先にそちらを流すよう案内します。`2026-10-fonts-to-css` を元に戻して `assets` が戻った環境でも
  同じく中止します(正しい挙動です)。
- editor サーバが停止していること(稼働中なら中止します)。
- dataRoot の確定領域(`templates` / `filled` / `css` / `sync` / `.gitignore` / `.gitattributes`。
  `css\fonts` は除く)に未コミットの変更がないこと。ただし `.gitignore` に `/images/` の 1 行が
  足されただけの状態(新版のサーバが承認時に先に足した場合)は中止せず、その差分をコミットします。
- 画像の置き場(`IMAGES_DIR` / appconfig の `paths.imagesDir`)が確定領域の内側にないこと
  (内側なら中止します。サーバも同じ条件で起動を止めます)。

## 手順

1. editor サーバを止める。
2. 新版の editor を配置する。
3. `apply.bat` を引数なしで実行し、確認モードで変更内容と点検結果を見る(何も変えません)。
4. `apply.bat -Apply` で実行する。
5. editor を起動する。

dataRoot は `-DataRoot <path>` で指定できます。省略時はサーバと同じ順(環境変数 `DATA_ROOT`、
ユーザー環境変数、appconfig の `paths.dataRoot`、既定)で決めます。画像の置き場は
`IMAGES_DIR`、appconfig の `paths.imagesDir`、`<dataRoot>\images` の順で決め、出典を表示します。
稼働確認のポートは `-Port <n>`(既定 24680)で変えられます。

## 何をするか

- `.gitignore` に `/images/` を追記する(画像を置く前に追跡外にする)。
- `images` フォルダが無ければ作る。
- `.gitignore` の変更を `system` 名義の 1 コミット(件名末尾に `[fund-images]`)にする。

すでに `/images/` がコミット済みで `images` もあれば、何も変えずに終わります(コミットも作りません)。

## 報告だけするもの

既に置かれている画像を点検し、次を一覧で表示します。動かしも消しもしません。

- `[subfolder]` `images` 直下以外(サブフォルダ)に置かれたファイル。配信されません。
- `[extension]` 許可外の拡張子(`.svg` `.png` `.jpg` `.jpeg` 以外)。配信されません。
- `[naming]` 命名 `<fund>_<名前>.<拡張子>` に合わないファイル。配信はされますが、約束から外れます。

SVG の中身の検査はサーバが行います(パッチは行いません)。違反した SVG はどの経路でも表示されず、
サーバログに警告(ファイル名と違反の内容)が出ます。

## 画像の置き方と外部ツールへの約束

- 置き場は `<dataRoot>\images\` の直下だけ。サブフォルダは作らない。
- ファイル名は `<fund>_<画像名>.<拡張子>`(例 `510037_logo.svg`)。拡張子は `.svg` `.png` `.jpg` `.jpeg`。
- 書き込みは一時名で書いてから改名する(書きかけを読ませないため)。
- 値入り HTML の参照は確定したパス(`images/510037_logo.svg`)で書き、`{{ fund.code }}` を残さない。
- SVG には `width` と `height` を書く(無いと `<img>` で 300×150 になる)。
- Illustrator は「書き出し(SVG 1.1)」で保存する。「Illustrator の編集機能を保持」で保存した SVG は
  検査で落ちます。

## 元に戻す

1. editor サーバを止める。
2. `rollback.bat` を引数なしで実行し、確認モードで内容を見る。
3. `rollback.bat -Apply` で実行する。

目印 `[fund-images]` の移行コミットを `git revert` します(すでに revert 済みなら飛ばします)。
revert が失敗したときは `git revert --abort` で戻してから中止し、git の出力を表示します。

`images` フォルダと中の画像は消しません(別ツールが置いた git 管理外のもので、戻せないため)。
不要なら手で消してください。

新版のサーバは承認時に `.gitignore` へ `/images/` を再び追記します。元に戻すことに意味があるのは、
サーバも旧版へ戻す場合だけです。
```

ルート `README.md` の入口スクリプト一覧で `editor/patches/2026-10-fonts-to-css/rollback.bat` の行の直後に追加:

```markdown
| `editor/patches/2026-10-fund-images/apply.bat` | data リポジトリにファンド別画像の置き場(images)を用意する(既定は確認モード、`-Apply` で実行) |
| `editor/patches/2026-10-fund-images/rollback.bat` | 上の変更を元に戻す(画像は消さない) |
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fund-images/apply.Tests.ps1"`
Expected: 12 件 PASS

Run: `for f in apply.ps1 rollback.ps1 apply.Tests.ps1; do head -c 3 editor/patches/2026-10-fund-images/$f | od -An -tx1; done`
Expected: 3 行とも `ef bb bf`

Run: `file editor/patches/2026-10-fund-images/*.bat`
Expected: `with CRLF line terminators`

- [ ] **Step 7: コミット**

```bash
git add editor/patches/2026-10-fund-images README.md
git commit -m "feat(editor): 既存環境にファンド別画像の置き場を用意するパッチ(確認モード既定・点検の報告・元に戻す手順つき)を追加する"
```

---

### Task 9: 運用手順書・設計正典・設計書を更新する

**Files:**
- Modify: `docs/editor/src/デプロイ運用手順書.md`（front-matter、設定表、3.1 節のフォルダ構成図、3.1 節の末尾）
- Modify: `docs/editor/src/設計正典.md`（モジュール構成の routes の行、相対参照の節 259-272 行付近、却下済み設計の末尾）
- Modify: `docs/editor/src/設計書.md`（9.1 節の 6.・経路別 CSP 一覧、9.2 節の見出しと表）
- Modify: `.claude/rules/design-canon-summary.md`（routes の行、却下項目の一覧。git 管理外のローカルファイル）
- Modify: `docs/editor/editor_設計.html`（再生成）

- [ ] **Step 1: 運用手順書を直す**

front-matter の `version` を `"1.5"` にし、`rev` の末尾に足す:

```yaml
  - 1.5 | <実施日> | ファンド別画像の置き場（`paths.imagesDir`）と画像の書き方・外部ツールへの約束（設定表・3.1 節）
```

設定表の `paths.jsDir` の行の直後に足す:

```markdown
| `paths.imagesDir` | ファンド別画像（既定 `dataRoot/images`。git 管理外。別ツールが置く。確定領域の内側は起動を中止する） | `IMAGES_DIR` |
```

3.1 節のフォルダ構成図の `js\` の行の直後に足す:

```
  images\                                ファンド別画像。別ツールが置く（git 管理外。命名 <fund>_<名前>.<拡張子>）
```

3.1 節の「元に戻すときは、…」の段落の直後に足す:

```markdown
ファンド別画像の置き方:

- 置き場は `images\` の直下だけ。サブフォルダは作らない。拡張子は `.svg` `.png` `.jpg` `.jpeg`。
- ファイル名は `<fund>_<画像名>.<拡張子>`（例 `510037_logo.svg`）。名前の規則はエディタが検査しない約束で、守らないと他ファンドの画像も名前で参照できてしまう。
- 画像はエディタの外（値入り HTML を置く別ツールなど）が置く。エディタは読んで表示するだけで、アップロード・差し替え・削除はできない。
- 外部ツールへの約束: 書き込みは一時名で書いてから改名する（書きかけを読ませないため）。値入り HTML の参照は確定したパス（`images/510037_logo.svg`）で書き、`{{ fund.code }}` を残さない（残すと PDF・プレビュー・編集画面のどれにも出ず、編集画面に警告が出る）。SVG には `width` と `height` を書く（無いと 300×150 で表示される）。
- SVG は Illustrator の「書き出し（SVG 1.1）」または Inkscape の「プレーン SVG」で保存する。「Illustrator の編集機能を保持」で保存した SVG はサーバの検査で落ち、どの経路でも表示されない。落ちた SVG はサーバログに警告（ファイル名と違反の内容）が出る。

画像の書き方:

- テンプレ（作成タブ）: `<img src="images/{{ fund.code }}_logo.svg">`。`{{ fund.code }}` はテンプレのファンドコードに置き換わる。
- 値入り HTML（編集タブ）: `<img src="images/510037_logo.svg">`（確定したパス）。
- ファンド CSS: `background: url(../images/510037_logo.svg)`。CSS 自身（`css\`）から見た相対パスで書く。`url(images/…)` と書くと `css/images/…` になって表示されない。CSS の背景画像は PDF と画面内プレビューにだけ出て、編集画面には出ない。
- 画像を差し替えたあと、画面内プレビューへの反映はブラウザの再読み込みが必要（取得した画像はページを開いている間だけ覚えている）。

既存環境への画像の置き場の追加:

1. editor サーバを止める。
2. 新版を配置する。
3. `editor\patches\2026-10-fund-images\apply.bat` を引数なしで実行し、確認モードで変更内容と、既に置かれた画像の点検結果（サブフォルダ・拡張子・命名）を見る。
4. `apply.bat -Apply` で実行する。`.gitignore` への `/images/` の追記と `images` フォルダの作成を行う。
5. editor を起動する。

詳細と元に戻し方は `editor/patches/2026-10-fund-images/README.md` を見る。
```

- [ ] **Step 2: 設計正典を直す**

モジュール構成の表の `server/src/routes/` の行の「Fastify ルート 9 本」を「Fastify ルート 10 本」にする。

相対参照の節で「リクエストの `css` は … 付け替えない。」の項目の直後に足す（既存の文体に合わせる）:

```markdown
- **ファンド別画像は `images/` に置き、配信経路は 1 本**: 置き場は `config.imagesDir`（既定
  `dataRoot/images`、git 管理外。確定領域の内側を指したら起動を中止する）。ファイル名は
  `<fund>_<名前>.<拡張子>`（`.svg` `.png` `.jpg` `.jpeg`、直下だけ）で、名前の規則は検査しない。
  PDF は `docAssets.ts` の `images` グループ（深さ 0）が参照された画像だけを配信ルートへ置く。
  画面内プレビューと編集画面は `GET /api/fund-assets/images/:file`（`routes/fundAssets.routes.ts`）
  だけから取り、プレビューホストのワイルドカードは `images/` を 404 にする。
- **SVG は 2 つの関所で `inspectSvg`（shared。許可リスト・字句走査・fail closed）を通す**:
  配置時（`stageDocAssets`。参照された SVG だけを検査し、違反は置かず警告。置くのは検査した
  バイト列そのもの）と単体配信時（違反は 404）。`resolveServedAssetSource` の呼び出し元が検査を
  通ることは `server/test/guardCoverage.guard.test.ts` が固定する。`data:image/svg+xml` は共有の
  許可リストへ足さず、プレビューの埋め込み（`previewSelfContain.ts`）が作るときだけ使う。
- **編集画面の画像は CSS で差し、属性を書き換えない**: canvas 専用の `<style>` に
  `img[src="<原文>"]{content:url("<配信 URL>")}` を書く（`features/editor/fundImageLayer.ts`）。
  値入り本文（`filled` が非空）は確定パスだけを差し、Jinja 本文は `{{ fund.code }}` をテンプレ ID の
  ファンドコードで解く。`{{` の残る値入り本文の参照は解かずに警告する。代替画像処理（image view の
  `onError`）は対象の `src` で止める。CSS の背景画像は編集画面では表示しない。
```

却下済み設計の末尾（「フォントを複数の配信パス…」の直後）に足す:

```markdown
- **編集画面で画像の `src` を書き換えて表示する**: しない。文字編集・ペースト・ドロップの取り込み口が
  複数あり、戻し忘れの経路が残ると配信ルートの URL が保存内容（下書き・申請・確定）へ混入する。
  CSS の `content: url()` なら属性を一切変えずに済む。
- **`data:image/svg+xml` を共有の許可リスト（`ALLOWED_DATA_PREFIXES`）へ足す**: しない。テンプレの
  著者が未検査の SVG を data URI で直接書けるようになる。
- **画像をプレビューホストのワイルドカード（`/api/preview-host/*`）でも配る**: しない。SVG 検査を
  通らない配信経路ができ、同じ実体を複数の配信パスで配ることになる。
```

- [ ] **Step 3: 設計書を直す**

9.1 節の 6. の「（9.2 節の 9 本 + openapi）」を「（9.2 節の 10 本 + openapi）」にする。経路別 CSP 一覧の表の `/api/render-host/**` の行の直後に足す:

```markdown
   | `/api/fund-assets/images/:file`（`routes/fundAssets.routes.ts`） | 全域のまま（SVG の応答だけ CSP を `sandbox` に置き換える） | 直接開かれた SVG を opaque オリジンに閉じ込める |
```

9.2 節の見出しを「## 9.2 routes 一覧（10 本 + openapi）」にし、表の末尾（`vivliostyle.routes.ts` の行の直後）に足す:

```markdown
| `fundAssets.routes.ts` | なし（`imagesDir` 直下の画像を読むだけ。SVG は `inspectSvg`） | なし |
```

- [ ] **Step 4: 要約と HTML を更新する**

`.claude/rules/design-canon-summary.md` の editor 節で「`server/src/routes/` — Fastify ルート 9 本。」を「10 本。」にし、却下済み設計の一覧の末尾（49 の次）に足す:

```markdown
50. 編集画面で画像の `src` を書き換えて表示する
51. `data:image/svg+xml` を共有の許可リスト（`ALLOWED_DATA_PREFIXES`）へ足す
52. 画像をプレビューホストのワイルドカード（`/api/preview-host/*`）でも配る
```

Run: `pnpm run check:canon-summary -- --update && pnpm run check:canon-summary`
Expected: OK

Run: `py -3.13 docs/_build/build_all.py --project editor`
Expected: `[ok] editor/editor_設計.html`（手引きも再生成されるが、コミットしない）

- [ ] **Step 5: コミット**

`git status --short` で、`docs/editor/editor_手引き.html` と `docs/editor/images/*.png` が変更一覧に出ていても**ステージしない**（この作業と無関係の差分を持っている）。

```bash
git add "docs/editor/src/デプロイ運用手順書.md" "docs/editor/src/設計正典.md" "docs/editor/src/設計書.md" "docs/editor/editor_設計.html"
git commit -m "docs(editor): ファンド別画像の置き場・配信経路の 1 本化・SVG 検査の関所・編集画面の CSS 表示を手順書と設計正典に反映する"
```

（`.claude/` は git 管理外なのでコミットに含めない。）

---

### Task 10: 全体の検証

実機の PDF 確認では、手で作った SVG・png に加え、Task 1b で置いた pdf-to-svg と pie-chart の実出力 SVG を 1 本ずつ `images/` に `<fund>_<名前>.svg` で置いて参照し、PDF に表示されることも確かめる。

**Files:** なし（確認のみ。直しが出たら該当 Task のファイルを直して追加コミット）

- [ ] **Step 1: 型・テスト・検査**

Run: `pnpm typecheck:editor && pnpm run test:editor && pnpm run check:comments && pnpm run check:canon-summary`
Expected: すべて成功

- [ ] **Step 2: coverage**

Run: `pnpm run test:coverage`
Expected: `svgInspect.ts`・`committedAreas.ts`・`fundAssets.routes.ts`・`web/src/lib/fundImages.ts`・`features/editor/fundImages.ts`・`features/editor/fundImageLayer.ts` がそれぞれ 85% 以上、`config.ts`・`docAssets.ts`・`previewHost.ts`・`previewSelfContain.ts` が閾値を保ち、全体の閾値を満たす。

- [ ] **Step 3: パッチのテスト**

Run: `powershell -NoProfile -Command "Import-Module Pester -MaximumVersion 4.99; Invoke-Pester -Script editor/patches/2026-10-fund-images/apply.Tests.ps1; Invoke-Pester -Script editor/patches/2026-10-fonts-to-css/migrate.Tests.ps1"`
Expected: どちらも全件 PASS（①のパッチが `.gitignore` の新しい必須行で退行していないこと）

- [ ] **Step 4: 実機で PDF に画像が出て、違反 SVG が出ないことを確かめる**

1. 一時の dataRoot を作る（PowerShell）:

```powershell
$t = Join-Path $env:TEMP ("fund-img-e2e-" + [guid]::NewGuid().ToString('N').Substring(0,8))
cmd /c "editor\scripts\init-data-repo.bat -DataRoot $t 2>nul"
$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText("$t\images\510037_logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ff0000"/></svg>', $utf8)
[IO.File]::WriteAllText("$t\images\510037_bad.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="alert(1)"><rect width="40" height="40" fill="#0000ff"/></svg>', $utf8)
[IO.File]::WriteAllBytes("$t\images\510037_photo.png", [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))
$body = @{
  html = '<html><body><img src="images/510037_logo.svg" width="40" height="40"><img src="images/510037_photo.png" width="40" height="40"><img src="images/510037_bad.svg" width="40" height="40"><div class="x"></div></body></html>'
  css  = '.x{width:40px;height:40px;background:url(../images/510037_logo.svg)}'
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText("$t-body.json", $body, $utf8)
```

2. 既定と違うポートで、local モードのサーバを起動する（バックグラウンド。出力はログとして残す）:

```powershell
$env:DATA_ROOT = $t; $env:PORT = '24690'; $env:AUTH_REQUIRED = 'false'; $env:LOG_DIR = "$t-logs"
pnpm --filter server exec tsx src/index.ts *> "$t-server.log"
```

3. PDF を作る: `curl.exe -s -o "$t.pdf" -H "Content-Type: application/json" --data-binary "@$t-body.json" http://127.0.0.1:24690/api/build`
4. PDF を確かめる:

```powershell
py -3.13 -c "import fitz,sys; d=fitz.open(sys.argv[1]); p=d[0]; pm=p.get_pixmap(dpi=96); s=pm.samples; n=pm.n; px=[s[i:i+3] for i in range(0,len(s),n)]; red=sum(1 for r,g,b in px if r>200 and g<60 and b<60); blue=sum(1 for r,g,b in px if b>200 and r<60 and g<60); print('red',red,'blue',blue,'images',len(p.get_images()))" "$t.pdf"
```

Expected: `red` が 0 より大きい（`<img>` の SVG と CSS 背景の SVG）、`blue` が 0（違反 SVG は置かれない）、`images` が 1 以上（png）。

5. 単体配信ルートを確かめる:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:24690/api/fund-assets/images/510037_bad.svg
curl.exe -s -D - -o NUL http://127.0.0.1:24690/api/fund-assets/images/510037_logo.svg
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:24690/api/preview-host/images/510037_logo.svg
```

Expected: 1 本目 `404`。2 本目のヘッダに `content-type: image/svg+xml`・`x-content-type-options: nosniff`・`cache-control: no-store`・`content-security-policy: sandbox`。3 本目 `404`。

6. サーバログ（`$t-server.log`）に `510037_bad.svg` の警告（`asset.svg_rejected`）が出ていることを確かめる。
7. サーバを止め、一時ファイルを消す: `Remove-Item -Recurse -Force $t, "$t-logs", "$t.pdf", "$t-body.json", "$t-server.log" -Confirm:$false`。環境変数 `DATA_ROOT` / `PORT` / `AUTH_REQUIRED` / `LOG_DIR` をこのシェルから外す。

- [ ] **Step 5: 結果を報告する**

失敗した項目は出力をそのまま添えて報告し、成功扱いにしない。
