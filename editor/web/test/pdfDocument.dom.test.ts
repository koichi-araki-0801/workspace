import { EXTERNAL_REF_MESSAGE, isErr, isOk } from '@editor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CROP_MARKS_CSS } from '@/lib/cropMarks';
import { assemblePreviewDocument } from '@/lib/nunjucksRender';
import { PDF_ERROR_MSG, postBuild, renderPdfDocument } from '@/lib/pdfDocument';
import { sanitizePdfRoot, sanitizePreviewRoot, serializePreviewRoot } from '@/lib/sanitizeHtml';

// 描画は opaque オリジンの iframe(`lib/renderHostClient.ts`)が行うため jsdom では起動しない。
// ここで固定したいのは PDF 入力文書の組み立て(サニタイズ・外部参照の拒否)なので、隔離の
// 向こう側にあたる nunjucks 実装を直に噛ませる。クライアントの契約は
// `renderHostClient.test.ts` が固定する。
vi.mock('@/lib/renderHostClient', async () => {
  const { renderJinja } = await import('./helpers/renderJinja');
  return { renderJinjaIsolated: async (t: string, d: unknown) => renderJinja(t, d as never) };
});

describe('renderPdfDocument', () => {
  it('renders Jinja values and keeps the template script', async () => {
    const res = await renderPdfDocument(
      '<p>{{ name }}</p><script>fitColumns()</scr' + 'ipt>',
      '.c{}',
      { name: 'ファンドA' },
    );
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.html).toContain('ファンドA');
      // テンプレの JS は正当なコンテンツ(列幅自動調整など)。ここで除去すると
      // PDF でインライン script が 1 つも効かず(実測で、残すと出力 PDF が変わる)、
      // 承認者は「JS が効いていない見た目」を承認することになる。
      expect(res.value.html).toContain('fitColumns()');
      expect(res.value.css).toBe('.c{}');
    }
  });

  // script を残すのは「サニタイズをやめた」のではない。外すのは script 要素の除去**だけ**で、
  // DOMPurify の他の防御(on* 属性 / javascript: URL / 危険要素)は維持する。
  it.each([
    ['<img src="img/a.png" onerror="alert(1)">', 'onerror', 'イベントハンドラ属性'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:', 'javascript: URL'],
    ['<object data="x.swf"></object>', '<object', '危険要素 object'],
    ['<base href="https://evil.example/">', '<base', 'base(相対解決先の乗っ取り)'],
    ['<meta http-equiv="refresh" content="0;url=x">', 'http-equiv', '宣言的リフレッシュ'],
  ])('script 以外の防御は維持する(%s → %s を残さない = %s)', async (html, needle) => {
    const res = await renderPdfDocument(html, '', {});
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.html).not.toContain(needle);
  });

  // ⚠ ここで `<link>` が残るのは「サニタイザが落とさない」だけの話で、**当たる CSS が
  // 2 枚になる訳ではない**。CSS の適用元を 1 つに保つ判断はサーバ側にあり、
  // `vivliostyle/inlineCss.ts` がリクエストに `css` がある限り stylesheet の `<link>` を
  // 落とす(= プレビューと同じ 1 枚)。両方当てると、下書きで削除した規則が
  // ディスクの旧 per-fund CSS から復活し、プレビューと PDF が食い違う。
  it('同梱資産への相対参照(link / script src)は残す', async () => {
    const html =
      '<html><head><link rel="stylesheet" href="../css/AM01_510037_交付版.css">' +
      '<script src="../js/column-width.js"></scr' +
      'ipt></head><body>x</body></html>';
    const res = await renderPdfDocument(html, '', {});
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.html).toContain('../css/AM01_510037_交付版.css');
      expect(res.value.html).toContain('../js/column-width.js');
    }
  });

  // PDF 経路は解決済み CSS を必ず `css` として運ぶ(= サーバがそれを唯一の源にできる)。
  // ここが空になると、サーバは `<link>` を残す分岐へ落ちてプレビューと食い違う。
  it('解決済み CSS を css として返す(サーバが唯一の源にできる形)', async () => {
    const res = await renderPdfDocument('<p>x</p>', 'p{color:red}', {});
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.css).toContain('p{color:red}');
  });

  it.each([
    ['<link rel="stylesheet" href="https://evil.example/x.css">', '外部 stylesheet'],
    ['<script src="//evil.example/x.js"></scr' + 'ipt>', 'scheme 相対の script'],
    ['<img src="http://evil.example/beacon.png">', 'ビーコン画像'],
  ])('HTML の絶対参照(%s = %s)で PDF を作らない', async (html) => {
    const res = await renderPdfDocument(html, '', {});
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(EXTERNAL_REF_MESSAGE);
  });

  it('appends trim-mark CSS only when cropMarks is on', async () => {
    const on = await renderPdfDocument('<p>x</p>', '.c{}', {}, { cropMarks: true });
    const off = await renderPdfDocument('<p>x</p>', '.c{}', {}, { cropMarks: false });
    expect(isOk(on) && on.value.css.includes(CROP_MARKS_CSS)).toBe(true);
    expect(isOk(off) && !off.value.css.includes(CROP_MARKS_CSS)).toBe(true);
  });

  it('returns err with the safe message when the template fails to render', async () => {
    const res = await renderPdfDocument('<p>{{ oops</p>', '', {});
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(PDF_ERROR_MSG);
  });

  // PDF は CSP の無い headless ブラウザで組版されるため、CSS からの外向き通信は
  // 「削る」ではなく「拒む」(削る実装は CSS のエスケープで必ず迂回される)。
  it.each([
    ['@import url(http://evil.example/x.css);', '素の @import'],
    ['@\\69 mport url(http://evil.example/x.css);', 'エスケープ難読化した @import'],
    ['.a{background:url(\\68ttp://evil.example/y.png)}', 'エスケープ難読化した絶対 URL'],
    ['.a{background:url(//evil.example/y.png)}', 'scheme 相対 URL'],
    ['@font-face{src:url("https://evil.example/f.woff2")}', '外部フォント'],
  ])('外部参照を含む CSS(%s = %s)で PDF を作らない', async (css) => {
    const res = await renderPdfDocument('<p>x</p>', css, {});
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe(EXTERNAL_REF_MESSAGE);
  });

  // 承認者は実行結果しか見ない運用(DECISIONS の Q10)なので、「PDF では動くのに
  // プレビューでは動かない」差は運用上の落とし穴になる。プレビューを opaque オリジンの
  // iframe へ隔離した(`PreviewPanel.vue` + `server/src/vivliostyle/previewHost.ts`)ことで
  // 除去の必要が消え、両経路とも script を残す。**この一致をここで機械固定する** —
  // 片方だけ黙って除去へ戻ると、承認者が「JS が効いていない見た目」を承認する形に戻る。
  it('PDF とプレビューは同じ入力で同じく script を残す', async () => {
    const html = `<html><head></head><body><p>x</p><scr${'ipt>'}fitColumns()</scr${'ipt>'}</body></html>`;
    const pdf = await renderPdfDocument(html, '', {});
    expect(isOk(pdf)).toBe(true);
    if (isOk(pdf)) expect(pdf.value.html).toContain('fitColumns()');
    expect(assemblePreviewDocument(html, '')).toContain('fitColumns()');
  });

  it('自己完結な CSS(相対パス / data:image / 文字列中の字面)は通す', async () => {
    const css =
      '.a{background:url(img/a.png)}' +
      '.b{background:url("data:image/png;base64,AAAA")}' +
      '.c::after{content:"@import url(http://evil.example/x)"}' +
      '/* @import url(http://evil.example/y) */' +
      '@media print{.d{color:red}}';
    const res = await renderPdfDocument('<p>x</p>', css, {});
    expect(isOk(res)).toBe(true);
  });

  it('会社フォルダが会社コードと合わない画像は <img src>・<style>・css の url() から落とす', async () => {
    const html =
      '<html><head><style>.h{background:url(../images/other/h.svg)}</style></head><body>' +
      '<img src="../images/smtam/qr.svg"><img src="../images/other/x.svg">' +
      '<img src="../images/510037_logo.svg"></body></html>';
    const css =
      '.b{background:url(../images/other/c.svg)}.c{background:url(../images/SMTAM/d.svg)}';
    const res = await renderPdfDocument(html, css, {}, { skipJinja: true, companyCode: 'SMTAM' });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.html).toContain('src="../images/smtam/qr.svg"');
    expect(res.value.html).toContain('src="../images/510037_logo.svg"');
    expect(res.value.html).not.toContain('other/x.svg');
    expect(res.value.html).not.toContain('other/h.svg');
    expect(res.value.css).not.toContain('other/c.svg');
    expect(res.value.css).toContain('url(../images/SMTAM/d.svg)');
  });

  it('外部参照の文言は文書基準の相対パスを案内する', () => {
    expect(EXTERNAL_REF_MESSAGE).toContain('../css/');
    expect(EXTERNAL_REF_MESSAGE).toContain('../images/');
  });
  it('会社フォルダが会社コードと合わない画像は style 属性の url() からも落とし、合うものは残す', async () => {
    const html =
      '<html><body><div style="background:url(../images/other/s.svg)">a</div>' +
      '<div style="background:url(../images/smtam/t.svg)">b</div>' +
      '<div style="background:url(../images/510037_u.svg)">c</div></body></html>';
    const res = await renderPdfDocument(html, '', {}, { skipJinja: true, companyCode: 'SMTAM' });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.html).not.toContain('other/s.svg');
    expect(res.value.html).toContain('url(../images/smtam/t.svg)');
    expect(res.value.html).toContain('url(../images/510037_u.svg)');
  });

  it('会社フォルダが合わない画像は srcset・<source srcset>・<input src>・<video poster> からも落とす', async () => {
    const html =
      '<html><body>' +
      '<img src="../images/smtam/a.svg" srcset="../images/smtam/a.svg 1x, ../images/other/a2.svg 2x">' +
      '<picture><source srcset="../images/other/p.svg"><img src="../images/smtam/p.svg"></picture>' +
      '<input type="image" src="../images/other/i.svg" alt="i">' +
      '<video poster="../images/other/v.svg"></video>' +
      '<video poster="../images/SMTAM/ok.svg"></video>' +
      '<img srcset="../images/smtam/k.svg 1x">' +
      '</body></html>';
    const res = await renderPdfDocument(html, '', {}, { skipJinja: true, companyCode: 'SMTAM' });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.html).not.toContain('other/');
    expect(res.value.html).toContain('src="../images/smtam/a.svg"');
    expect(res.value.html).toContain('src="../images/smtam/p.svg"');
    expect(res.value.html).toContain('poster="../images/SMTAM/ok.svg"');
    expect(res.value.html).toContain('srcset="../images/smtam/k.svg 1x"');
  });
});

describe('sanitizePdfRoot — script の defer/async と meta charset', () => {
  const pdf = (html: string): string => serializePreviewRoot(sanitizePdfRoot(html));

  it('script の defer と async を残す', () => {
    const out = pdf(
      '<html><head><script defer src="../js/a.js"></script></head>' +
        '<body><script async>var x = 1;</script></body></html>',
    );
    expect(out).toMatch(
      /<script[^>]*\bdefer\b[^>]*src="..\/js\/a.js"|<script[^>]*src="..\/js\/a.js"[^>]*\bdefer\b/,
    );
    expect(out).toMatch(/<script[^>]*\basync\b[^>]*>var x = 1;/);
  });

  it('charset だけを持つ meta は残し、ほかの meta は落とす', () => {
    const out = pdf(
      '<html><head><meta charset="utf-8">' +
        '<meta http-equiv="refresh" content="0;url=https://evil/">' +
        '<meta name="viewport" content="width=device-width">' +
        '<meta charset="utf-8" http-equiv="refresh" content="0;url=https://evil/">' +
        '</head><body>x</body></html>',
    );
    expect(out.match(/<meta\b[^>]*>/g)).toEqual(['<meta charset="utf-8">']);
    expect(out).not.toContain('evil');
    expect(out).not.toContain('viewport');
  });

  it('プレビュー用のサニタイズは meta を従来どおりすべて落とす', () => {
    const out = serializePreviewRoot(
      sanitizePreviewRoot('<html><head><meta charset="utf-8"></head><body>x</body></html>'),
    );
    expect(out).not.toContain('<meta');
  });
});

describe('postBuild', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('JSON を POST して成功時は Blob を返す', async () => {
    const blob = new Blob(['%PDF']);
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await postBuild('/build', { html: '<p/>' });
    expect(res).toEqual({ ok: true, value: blob });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/build');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"html":"<p/>"}');
  });

  it('HTTP エラーは PDF_ERROR_MSG の conflict(cause に状態)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    const res = await postBuild('/build', {});
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.message).toBe(PDF_ERROR_MSG);
      expect(res.error.cause).toBe('HTTP 500');
    }
  });
});
