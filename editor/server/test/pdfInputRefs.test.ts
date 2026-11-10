// =============================================================================
// pdfInputRefs.test.ts — 単体 PDF の入力 HTML の参照を dataRoot の資産の置き場に限る
// =============================================================================
// create_report は `pdf-input/<id>.html` の相対参照をパスのとおりにファイルとして読む。
// 外へ出る参照・ルート相対・ドライブ付きの絶対パス・埋め込み文書の要素を拒み、
// テンプレが使う `../css/…`・`../images/…`・`../js/…` は通すことを確かめる。
import { REPORT_INPUT_REF_OUTSIDE } from '@editor/shared';
import { describe, expect, it } from 'vitest';
import { assertPdfInputRefsContained } from '../src/security/pdfInputRefs.js';

const WHERE = 'report-pdf';

function rejects(html: string): void {
  let caught: unknown;
  try {
    assertPdfInputRefsContained(html, WHERE);
  } catch (err) {
    caught = err;
  }
  expect(caught, html).toMatchObject({ kind: 'validation', code: REPORT_INPUT_REF_OUTSIDE });
}

describe('assertPdfInputRefsContained', () => {
  it.each([
    '<iframe src="../../../../x/appconfig.json"></iframe>',
    '<iframe srcdoc="<p>x</p>"></iframe>',
    '<object data="../.."></object>',
    '<embed src="../css/a.css">',
    '<frame src="../css/a.css">',
    '<img src="/C:/x/appconfig.json">',
    '<img src="/images/a.svg">',
    '<img src="C:/x/a.png">',
    '<img src="file:///C:/x/a.png">',
    '<link rel="stylesheet" href="../../x.css">',
    '<div style="background:url(../../x.png)"></div>',
    '<div style="background:url(&#46;&#46;/&#46;&#46;/x.png)"></div>',
    '<img srcset="../images/a.svg 1x, ../../x.png 2x">',
    '<img src="../pdf-input/other.html">',
    '<img src="../templates/a.html">',
    '<img src="x.png">',
    '<img src="..\\..\\x.png">',
    '<img src="../css/%2e%2e/%2e%2e/x.png">',
    '<script src="../../x.js"></script>',
    '<svg><image href="../../x.png"></image></svg>',
    '<style>.a{background:url("../../x.png")}</style>',
    '<style>.a{background:image-set("../../x.png" 1x)}</style>',
    '<style>@import url(../css/a.css);</style>',
    '<meta http-equiv="refresh" content="0;url=../../x/appconfig.json">',
    '<svg><title><img src="../../x.png"></title></svg>',
  ])('rejects %s', (html) => {
    rejects(html);
  });

  it.each([
    '<link rel="stylesheet" href="../css/XX01_950037_交付版.css">',
    '<img src="../images/XX01/a.svg">',
    '<img src="../images/a.png?v=1#x">',
    '<script src="../js/x.js"></script>',
    '<img srcset="../images/a.svg 1x, ../images/b.svg 2x">',
    '<style>@font-face{src:url(../css/fonts/a.woff2) format("woff2")}</style>',
    '<div style="background:url(../images/a.png)"></div>',
    '<svg><use href="#a"></use></svg>',
    '<img src="data:image/png;base64,AAAA">',
    '<a href="../../x/appconfig.json">link</a>',
    '<img src="">',
    '<p>本文</p>',
  ])('accepts %s', (html) => {
    expect(() => assertPdfInputRefsContained(html, WHERE)).not.toThrow();
  });

  it('reports the offending refs in cause', () => {
    let caught: { cause?: { where?: string; refs?: string[] } } | undefined;
    try {
      assertPdfInputRefsContained('<img src="../../x.png"><img src="../images/a.png">', WHERE);
    } catch (err) {
      caught = err as typeof caught;
    }
    expect(caught?.cause?.where).toBe(WHERE);
    expect(caught?.cause?.refs).toEqual(['<img src="../../x.png">']);
  });
});
