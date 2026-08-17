// =============================================================================
// externalRefs.test.ts — build 入口の外部参照ゲート(サーバ側が関門であること)
// =============================================================================
// 検査がブラウザの `web/src/lib/pdfDocument.ts` にしか無いと、公開 API へ直接 POST すれば
// 無検査で headless ブラウザへ届く。よって本テストの重心は「**UI を経由しない経路**が
// 4xx になる」ことの主張に置く。純関数の単体だけでは、この退行はまた見逃される。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TMP_DIR = path.join(
  os.tmpdir(),
  `editor-extref-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
);
process.env.TMP_DIR = TEST_TMP_DIR;

const {
  findDocumentExternalRefs,
  assertNoDocumentExternalRefs,
  assertNoMarkdownExternalRefs,
  assertNoJsonExternalRefs,
  assertProjectDirHasNoExternalRefs,
  findJsonExternalRefs,
  EXT_INSPECTION,
  EXTERNAL_REF_CODE,
  UNPARSABLE_CODE,
} = await import('../src/security/externalRefs.js');
const { ALLOWED_EXTENSIONS } = await import('../src/vivliostyle/projectInput.js');
const { MERGE_PAGE_COUNTER_CSS } = await import('../src/vivliostyle/mergeInput.js');

describe('findDocumentExternalRefs — 検査面の網羅', () => {
  it('リクエストの css に置いた外部参照を拾う', () => {
    expect(findDocumentExternalRefs('<p>x</p>', '@import url(http://evil/x.css);')).not.toEqual([]);
    expect(
      findDocumentExternalRefs('<p>x</p>', '.a{background:url(http://evil/x.png)}'),
    ).not.toEqual([]);
    // CSS のエスケープで `url(` を隠す形も、エスケープ解決後に判定するので拾う。
    expect(
      findDocumentExternalRefs('<p>x</p>', '.a{background:url(\\68ttp://evil/x)}'),
    ).not.toEqual([]);
  });

  it('HTML の <style> ブロックに埋めた外部参照を拾う(DOMPurify は中身を逐語保存する)', () => {
    const html = '<html><head><style>@import url(http://evil/x.css);</style></head><body/></html>';
    expect(findDocumentExternalRefs(html, '')).not.toEqual([]);
  });

  it('HTML の style 属性に埋めた外部参照を拾う', () => {
    const html = `<div style="background:url(http://evil/x.png)">x</div>`;
    expect(findDocumentExternalRefs(html, '')).not.toEqual([]);
    expect(findDocumentExternalRefs(`<div style=url(http://evil/x)>x</div>`, '')).not.toEqual([]);
  });

  // 値は走査器が切り出したものを使う。原文への正規表現だと `data-style` や
  // 他属性の値の中の字面を拾ってしまい、正当な文書を 400 にしてしまう。
  it('style 以外の属性にある字面は誤検知しない', () => {
    expect(findDocumentExternalRefs('<div data-style="url(http://x/y)">x</div>', '')).toEqual([]);
    expect(findDocumentExternalRefs('<img alt="style=url(http://x/y)">', '')).toEqual([]);
  });

  it('引用符文字列で URL を取る CSS 関数(image-set)も拾う', () => {
    const css = '.a{background-image:image-set("http://evil/x.png" 1x)}';
    expect(findDocumentExternalRefs('<p>x</p>', css)).not.toEqual([]);
    expect(
      findDocumentExternalRefs('<p>x</p>', '.a{background-image:-webkit-image-set("//evil/x" 1x)}'),
    ).not.toEqual([]);
  });

  it('自社の通しページ番号 CSS は通す(自分のゲートを自分で塞がない)', () => {
    expect(findDocumentExternalRefs('<p>x</p>', MERGE_PAGE_COUNTER_CSS)).toEqual([]);
  });

  // 走査を諦めた入力(閉じないタグ等)は `inlineCss` が「加工せず包むだけ」に倒れる =
  // HTML がそのまま headless へ届く入力である。ここを「検査できないから通す」にすると
  // 閉じないタグを 1 つ置くだけでゲートを回避できるので、全体を CSS として舜めて拒否側へ倒す。
  it('タグ走査が一意に決まらない HTML はそれ自体を拒む', () => {
    const html = '<div style="x><style>@import url(http://evil/x)';
    expect(() => assertNoDocumentExternalRefs(html, '', 'test')).toThrow();
    // 走査できる入力はこの分岐へ落ちない。
    expect(() => assertNoDocumentExternalRefs('<div>x</div>', '', 'test')).not.toThrow();
    // 列挙関数単体でも css 側の検査は落ちない(多層防御)。
    expect(findDocumentExternalRefs(html, '@import url(http://evil/y.css);')).not.toEqual([]);
  });

  // ── HTML の取得系属性 ──
  // 同梱資産(`css/…` `fonts/…` `js/…`)への相対参照は**通さねばならない**要件で、
  // 落ちるのはオリジン外の絶対参照だけ。両方を主張しないと、次に触る人が
  // 「link/script を全部落とせば安全」へ倒してテンプレを壊す。
  it.each([
    ['<link rel=stylesheet href="https://evil/x.css">', '外部 stylesheet'],
    ['<script src="//evil/x.js"></scr' + 'ipt>', 'scheme 相対の script'],
    ['<img src="http://evil/beacon.png">', 'ビーコン画像'],
    ['<iframe src="https://evil/"></iframe>', '外部 iframe'],
    ['<image xlink:href="https://evil/x.png"/>', 'SVG の xlink:href'],
    ['<img srcset="img/a.png 1x, https://evil/b.png 2x">', 'srcset の 2 つ目だけ外部'],
  ])('HTML の取得系属性に置いた絶対参照を拾う(%s = %s)', (html) => {
    expect(findDocumentExternalRefs(`<html><body>${html}</body></html>`, '')).not.toEqual([]);
  });

  it('同梱資産への相対参照は通す(css/ fonts/ js/)', () => {
    const html =
      '<html><head>' +
      '<link rel="stylesheet" href="css/510037.css">' +
      '<script src="js/column-width.js"></scr' +
      'ipt>' +
      '</head><body><img src="img/logo.png"><use xlink:href="#m"/></body></html>';
    expect(findDocumentExternalRefs(html, '')).toEqual([]);
  });

  // `<a href>` は組版中に 1 バイトも取りに行かない。ここを弾いても egress は減らず、
  // 引用元 URL を書いた帳票が全部 400 になるだけ。
  it('<a href="https://…"> は拒まない', () => {
    expect(findDocumentExternalRefs('<p><a href="https://example.com/">出典</a></p>', '')).toEqual(
      [],
    );
  });

  it('相対参照・断片・許可 data: と通常の content 文字列は通す', () => {
    const css = [
      '@page{size:A4}',
      '@media print{.a{color:#000}}',
      '.b{background:url(./img/logo.png)}',
      '.c{clip-path:url(#mask)}',
      '.d{content:"注: 説明"}',
      '.e{font-family:"BIZ UDPGothic"}',
      '@font-face{font-family:"X";src:url(data:font/woff2;base64,AAAA)}',
    ].join('\n');
    expect(findDocumentExternalRefs('<p>x</p>', css)).toEqual([]);
  });
});

describe('POST /build 系 — UI を経由しない経路が拒否される', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const Fastify = (await import('fastify')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { vivliostyleRoutes } = await import('../src/routes/vivliostyle.routes.js');
    app = Fastify();
    app.setErrorHandler(errorHandler);
    // zip パーサは `vivliostyleRoutes` が自分の encapsulation 内へ登録する(ここでは張らない)。
    await app.register(vivliostyleRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await fs.rm(TEST_TMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it.each([
    ['@import', { html: '<p>x</p>', css: '@import url(http://evil/x.css);' }],
    ['url(絶対URL)', { html: '<p>x</p>', css: '.a{background:url(http://evil/x.png)}' }],
    [
      'image-set 文字列',
      { html: '<p>x</p>', css: '.a{background-image:image-set("http://e/x" 1x)}' },
    ],
    [
      '<style> 埋め込み',
      { html: '<html><head><style>@import url(http://evil/x)</style></head></html>', css: '' },
    ],
    // HTML の取得系属性。UI を通さず公開 API へ直接 POST しても同じ関門に当たる。
    [
      '<link href=絶対URL>',
      {
        html: '<html><head><link rel=stylesheet href="https://evil/x.css"></head></html>',
        css: '',
      },
    ],
    [
      '<script src=絶対URL>',
      { html: `<html><body><script src="https://evil/x.js"></scr${'ipt>'}</body></html>`, css: '' },
    ],
  ])('POST /build は %s を 4xx で拒む', async (_label, body) => {
    const res = await app.inject({ method: 'POST', url: '/build', payload: body });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().code).toBe(EXTERNAL_REF_CODE);
  });

  it('POST /build/merge は 1 文書でも外部参照を持てば拒む', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/build/merge',
      payload: {
        documents: [
          { html: '<p>a</p>', css: '.a{color:red}' },
          { html: '<p>b</p>', css: '@import url(http://evil/x.css);' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(EXTERNAL_REF_CODE);
  });

  // zip 経路は `inlineCss` の `<base>` 除去を通らない。除去に頼ると防御が egressGuard 単独に
  // 落ちるので、展開直後の検査で 400 にする。
  it('POST /build/project は zip 同梱の .html に置いた <base> を拒む', async () => {
    const z = new JSZip();
    z.file(
      'index.html',
      '<html><head><base href="https://evil.example/"></head><body>x</body></html>',
    );
    const zip = await z.generateAsync({ type: 'nodebuffer' });
    const res = await app.inject({
      method: 'POST',
      url: '/build/project',
      headers: { 'content-type': 'application/zip' },
      payload: zip,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(EXTERNAL_REF_CODE);
  });

  it('POST /build/project は zip 同梱の .css に置いた外部参照を拒む', async () => {
    const z = new JSZip();
    z.file('index.html', '<p>x</p>');
    // サブディレクトリに置いても同じ(検査は展開ツリー全体を見る)。
    z.file('assets/theme.css', '.a{background:url(http://evil/x.png)}');
    const zip = await z.generateAsync({ type: 'nodebuffer' });
    const res = await app.inject({
      method: 'POST',
      url: '/build/project',
      headers: { 'content-type': 'application/zip' },
      payload: zip,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(EXTERNAL_REF_CODE);
  });
});

// ── 迂回入力(実測でゲートを通り抜けていた形)──
// サーバの走査器は属性値を「引用符を外しただけの原文」で渡す。ブラウザは文字参照を解き
// URL から TAB/LF/CR を落とすので、正規化しないと届く先だけが絶対 URL になる。
// これは「唯一の関門であるサーバがクライアントより弱い」形そのものである。
describe('findDocumentExternalRefs — 実体参照・制御文字・srcdoc での迂回', () => {
  const LF = String.fromCharCode(0x0a);

  it.each([
    ['取得系属性の 10 進文字参照', '<img src="&#104;ttp://127.0.0.1:1433/x.png">'],
    ['取得系属性の 16 進文字参照', '<img src="&#x68;ttps://evil.example/x.png">'],
    ['取得系属性の名前つき参照', '<script src="https&colon;//evil.example/x.js"></script>'],
    ['取得系属性の URL 途中改行', `<img src="htt${LF}ps://evil.example/x.png">`],
    ['style 属性の文字参照', '<div style="background:url(&#104;ttp://evil.example/x)"></div>'],
    ['iframe srcdoc の中の絶対参照', '<iframe srcdoc="<img src=https://evil.example/x>"></iframe>'],
    [
      'iframe srcdoc(実体参照で書いた形)',
      '<iframe srcdoc="&lt;link rel=stylesheet href=https://evil.example/a.css&gt;"></iframe>',
    ],
    [
      'iframe srcdoc の中の @import',
      '<iframe srcdoc="<style>@import url(http://evil/x)</style>"></iframe>',
    ],
  ])('%s は外部参照として報告される', (_label, html) => {
    expect(findDocumentExternalRefs(html, '')).not.toEqual([]);
    expect(() => assertNoDocumentExternalRefs(html, '', 'test')).toThrow();
  });

  it('srcdoc の中身が同梱資産への相対参照なら通る(遮断しすぎない)', () => {
    const html = '<iframe srcdoc="<link rel=stylesheet href=css/510037.css>"></iframe>';
    expect(findDocumentExternalRefs(html, '')).toEqual([]);
  });

  it('正規化しても同梱資産への相対参照は通る(業務を止めない)', () => {
    const html =
      '<link rel="stylesheet" href="css/510&#48;37.css">' +
      '<script src="js/column-width.js"></script>' +
      '<div style="background:url(img/logo.png)"></div>';
    expect(findDocumentExternalRefs(html, '')).toEqual([]);
  });
});

// ── 入れ子 srcdoc の fail-open ──
// トップレベルは `scanTags` が諦めたら `UNPARSABLE_CODE` で拒む(fail closed)。入れ子を
// CSS 走査へ**降格**し、失敗前に解析済みのタグを捨てる形にすると、CSS 走査は
// 引用符なし属性値を 1 つも見ないので、下記が零件で通ってしまう。
describe('入れ子 srcdoc が走査不能なら fail closed', () => {
  it('srcdoc の中に閉じないタグを置いても零件で通らない', () => {
    const html = '<iframe srcdoc="<img src=https://evil.example/x><b"></iframe>';
    expect(findDocumentExternalRefs(html, '')).not.toEqual([]);
    expect(() => assertNoDocumentExternalRefs(html, '', 'test')).toThrow();
  });

  it('走査を諦める前に読めたタグは検査する(手前の全タグが消えない)', () => {
    const html =
      '<iframe srcdoc="<link rel=stylesheet href=https://evil.example/a.css><b"></iframe>';
    const refs = findDocumentExternalRefs(html, '');
    expect(refs.some((r) => r.includes('evil.example'))).toBe(true);
  });

  it('入れ子の中の閉じない <style> も fail closed', () => {
    const html = '<iframe srcdoc="<style>.a{color:red}"></iframe>';
    expect(findDocumentExternalRefs(html, '')).not.toEqual([]);
  });

  it('走査できる srcdoc の相対参照は従来どおり通る(遮断しすぎない)', () => {
    const html = '<iframe srcdoc="<img src=img/logo.png>"></iframe>';
    expect(findDocumentExternalRefs(html, '')).toEqual([]);
  });
});

// ── 検査器そのものの穴(文字列終端・正規化・列挙漏れ)が build 入口まで届いていることの主張 ──
// 純関数側の単体は shared 側にあるが、「上流のゲートが静かに素通しになる」ことの実害は
// この入口で測るのが正しい。
describe('検査器の終端・正規化の穴が build 入口を素通りしない', () => {
  const LF = String.fromCharCode(0x0a);

  it.each([
    [
      '未終端の引用符で以降の CSS が消える(CSS 側)',
      '<p>x</p>',
      `.a{content:"oops${LF}}${LF}body{background:url(http://evil.example/x.png)}`,
    ],
    [
      '未終端の引用符で以降の CSS が消える(<style> 側)',
      `<style>.a{content:"oops${LF}}${LF}@import url(http://evil.example/x.css);</style>`,
      '',
    ],
    ['バックスラッシュの scheme 相対', '<img src="\\\\evil.example/x.png">', ''],
    ['SVG script の xlink:href', '<svg><script xlink:href="https://evil.example/x.js"/></svg>', ''],
    [
      'meta http-equiv=refresh',
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
      '',
    ],
    [
      'link rel=preload の imagesrcset',
      '<link rel="preload" as="image" ' +
        'imagesrcset="img/a.png 1x, https://evil.example/b.png 2x">',
      '',
    ],
  ])('%s は 400 の対象になる', (_label, html, css) => {
    expect(findDocumentExternalRefs(html, css)).not.toEqual([]);
    expect(() => assertNoDocumentExternalRefs(html, css, 'test')).toThrow();
  });
});

// ── 展開を許す形式は必ず検査する ──
// `projectInput.ts` の `ALLOWED_EXTENSIONS` のうち「参照を書ける形式」を覆えていないと、
// そこが検査ゲートの外側になる。`.md` は vivliostyle が原稿として組版し、`.svg` は
// `<image href>` / `<use href>` / `<style>` を持つ。
describe('markdown と SVG の外部参照', () => {
  it('markdown の画像・リンク・参照定義の絶対 URL を拒む(タグが無く HTML 走査では拾えない)', () => {
    for (const md of [
      '![logo](https://evil.example/x.png)',
      '[link](http://evil.example/)',
      '![logo]\n\n[logo]: https://evil.example/x.png',
      '![logo](<https://evil.example/x.png>)',
    ])
      expect(() => assertNoMarkdownExternalRefs(md, 'project:doc.md'), md).toThrow();
  });

  it('markdown 内の生 HTML も同じ基準で見る', () => {
    expect(() =>
      assertNoMarkdownExternalRefs(
        '本文\n\n<img src="https://evil.example/x.png">',
        'project:doc.md',
      ),
    ).toThrow();
  });

  it('同梱資産への相対参照は通す(組版に必要な正当な形)', () => {
    assertNoMarkdownExternalRefs('![z](images/z.png)', 'project:doc.md');
    assertNoMarkdownExternalRefs('[a](./other.md)', 'project:doc.md');
    assertNoMarkdownExternalRefs('文章だけ', 'project:doc.md');
  });

  it('SVG は文書として検査される(タグ構造なので HTML 走査が効く)', () => {
    expect(() =>
      assertNoDocumentExternalRefs(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
        '',
        'project:a.svg',
      ),
    ).toThrow();
  });
});

// ── raw text として読み飛ばした範囲も検査する ──
// 走査器は `title` / `textarea` / `noscript` を常に raw text として飛ばすが、HTML 名前空間の
// 外ではそうではない。`<svg><title>` は foreign content で、内側の `<img>` は実要素になる。
describe('raw text の内側の外部参照', () => {
  it('<svg><title> の内側の絶対 URL を拾う', () => {
    expect(() =>
      assertNoDocumentExternalRefs(
        '<svg><title><img src="https://evil.example/x.png"></title></svg>',
        '',
        'doc',
      ),
    ).toThrow();
  });

  it('<noscript> / <textarea> の内側も同様', () => {
    for (const html of [
      '<noscript><img src="https://evil.example/x.png"></noscript>',
      '<svg><textarea><image href="https://evil.example/x.png"></textarea></svg>',
    ])
      expect(() => assertNoDocumentExternalRefs(html, '', 'doc'), html).toThrow();
  });

  it('script の中身は参照として数えない(JS であってマークアップではない)', () => {
    // 字面の一致を参照として数えると誤検知になる。実行面の固定は `templateScripts` の担当。
    assertNoDocumentExternalRefs(
      '<script>var url = "https://example.com/api";</script>',
      '',
      'doc',
    );
  });
});

// ── 検査対象は「展開を許す拡張子」から導出する ──
// 2 つの集合を人手で並べていると、片方だけ増えた拡張子が検査ゲートの外側に落ちる
// (`.md` / `.svg` が実際にそうだった)。分類表が全キーを覆っていることを機械で要求する。
describe('EXT_INSPECTION は ALLOWED_EXTENSIONS の全キーに分類を与える', () => {
  it('キー集合の差が両方向とも空', () => {
    const allowed = [...ALLOWED_EXTENSIONS].sort();
    const classified = Object.keys(EXT_INSPECTION).sort();
    expect(classified).toEqual(allowed);
  });

  it('参照を書ける形式は inert になっていない', () => {
    for (const ext of ['.html', '.htm', '.xhtml', '.xht', '.svg', '.md', '.markdown', '.css']) {
      expect(EXT_INSPECTION[ext], ext).not.toBe('inert');
    }
    // `.json`(publication manifest)と `.css.map` は JSON として中身を見る。
    expect(EXT_INSPECTION['.json']).toBe('json');
    expect(EXT_INSPECTION['.css.map']).toBe('json');
  });
});

// ── JSON(publication manifest / source map)──
// vivliostyle は publication manifest を読んで原稿・資産の場所を決める。ここに絶対 URL を
// 書けば、HTML にも CSS にも 1 バイトも書かずに外部から取りに行かせられる。
describe('JSON の外部参照', () => {
  it('publication manifest の readingOrder に絶対 URL を書けない', () => {
    const manifest = JSON.stringify({
      '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
      readingOrder: ['index.html', 'https://evil.example/x.html'],
    });
    expect(findJsonExternalRefs(manifest)).not.toEqual([]);
    expect(() => assertNoJsonExternalRefs(manifest, 'project:publication.json')).toThrow();
  });

  it('JSON-LD の必須 @context は完全一致で通す(正当な manifest を 400 にしない)', () => {
    const manifest = JSON.stringify({
      '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
      type: 'Book',
      name: '報告書',
      readingOrder: ['index.html', 'sub/a.html'],
      resources: [{ url: 'img/logo.png' }],
    });
    expect(findJsonExternalRefs(manifest)).toEqual([]);
    assertNoJsonExternalRefs(manifest, 'project:publication.json');
  });

  it('@context に似せた別 URL は通らない(前方一致で緩めない)', () => {
    for (const ctx of ['https://schema.org.evil.example/', 'https://schema.org/x']) {
      expect(findJsonExternalRefs(JSON.stringify({ '@context': ctx })), ctx).not.toEqual([]);
    }
  });

  it('JSON として読めないファイルは fail closed で 400', () => {
    try {
      assertNoJsonExternalRefs('{"a":', 'project:x.json');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(UNPARSABLE_CODE);
    }
  });
});

// ── `<base>` は URL の形を見ずに拒む ──
// 相対解決の土台を丸ごと外部へ移せるので、相対 href でも拒む。zip project 経路は
// `inlineCss` の除去を通らないため、ここが一次関門になる。
describe('<base> は形を問わず外部参照として拒む', () => {
  it.each([
    ['絶対 URL', '<base href="https://evil.example/">'],
    ['相対 href', '<base href="css/x.css">'],
    ['href 無し', '<base target="_blank">'],
    ['大文字', '<BASE HREF="css/x.css">'],
    ['タグ名直後のスラッシュ', '<base/href="css/x.css">'],
  ])('%s は拒む', (_label, tag) => {
    const html = `<html><head>${tag}</head><body>x</body></html>`;
    expect(findDocumentExternalRefs(html, '')).not.toEqual([]);
    expect(() => assertNoDocumentExternalRefs(html, '', 'doc')).toThrow();
  });

  it('`</base>` 単体(終了タグ)では拒まない', () => {
    expect(findDocumentExternalRefs('<html><body>x</body></html>', '')).toEqual([]);
  });
});

// ── 展開ディレクトリ全体の検査(zip 経路の唯一の関所)──
describe('assertProjectDirHasNoExternalRefs — 分類は小文字 basename の末尾一致', () => {
  const dirs: string[] = [];
  const makeDir = async (files: Record<string, string>): Promise<string> => {
    const dir = path.join(TEST_TMP_DIR, `proj-${crypto.randomBytes(4).toString('hex')}`);
    for (const [name, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), body, 'utf8');
    }
    dirs.push(dir);
    return dir;
  };
  afterAll(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('.css.map の中の絶対 URL を拾う(extname では .map になり分類から漏れていた)', async () => {
    const dir = await makeDir({
      'style.css.map': JSON.stringify({ sources: ['https://evil.example/a.css'] }),
    });
    await expect(assertProjectDirHasNoExternalRefs(dir)).rejects.toMatchObject({
      code: EXTERNAL_REF_CODE,
    });
  });

  it('publication.json の絶対 URL を拾う', async () => {
    const dir = await makeDir({
      'publication.json': JSON.stringify({ readingOrder: ['http://evil.example/x.html'] }),
    });
    await expect(assertProjectDirHasNoExternalRefs(dir)).rejects.toMatchObject({
      code: EXTERNAL_REF_CODE,
    });
  });

  it('<base> 入りの .html を拒む', async () => {
    const dir = await makeDir({ 'index.html': '<html><head><base href="x/"></head></html>' });
    await expect(assertProjectDirHasNoExternalRefs(dir)).rejects.toMatchObject({
      code: EXTERNAL_REF_CODE,
    });
  });

  it('同梱資産だけの正当なプロジェクトは通る(業務を止めない)', async () => {
    const dir = await makeDir({
      'index.html':
        '<html><head><link rel=stylesheet href="css/a.css"></head><body>x</body></html>',
      'css/a.css': '.a{background:url(../img/logo.png)}',
      'doc.md': '![z](images/z.png)',
      'publication.json': JSON.stringify({
        '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
        readingOrder: ['index.html'],
      }),
      'style.css.map': JSON.stringify({ sources: ['a.css'], names: [] }),
    });
    await assertProjectDirHasNoExternalRefs(dir);
  });
});
