// =============================================================================
// externalRefs.test.ts — build 入口の外部参照ゲート(サーバ側が関門であること)
// =============================================================================
// 以前は検査がブラウザの `web/src/lib/pdfDocument.ts` にしか無く、公開 API へ直接 POST すれば
// 無検査で headless ブラウザへ届いた。よって本テストの重心は「**UI を経由しない経路**が
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

const { findDocumentExternalRefs, assertNoDocumentExternalRefs, EXTERNAL_REF_CODE } = await import(
  '../src/security/externalRefs.js'
);
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
    app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
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
