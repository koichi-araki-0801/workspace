// =============================================================================
// previewSelfContain.test.ts — プレビュー文書の自己完結化(子の要求ゼロ化)
// =============================================================================
// 認証オン配備では opaque オリジンの子フレームの要求にセッション cookie が付かない
// (SameSite=Lax)。ここで検証するのは「親が取得して埋める」変換の 3 性質:
//   1. 展開される — 配信ルートに解決される script src / fonts url() は文書へ埋まる
//   2. fail closed — 展開できない形は**原文のまま**残る(文書破壊に倒れない)
//   3. 取得はキャッシュされる — 再描画のたびに同じ資産を fetch しない
import { isSelfContainedUrl } from '@editor/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assetUrl,
  resetSelfContainCache,
  selfContainPreviewDoc,
} from '../src/lib/previewSelfContain';

/** 応答を rel パス単位で組み立てる簡易 fetcher(呼び出し回数の検査に使う)。 */
function fetcherFor(routes: Record<string, string | Uint8Array>) {
  return vi.fn(async (url: string): Promise<Response> => {
    const rel = url.replace('/api/preview-host/', '');
    const hit = routes[rel];
    if (hit === undefined) return new Response(null, { status: 404 });
    return new Response(hit, { status: 200 });
  });
}

const DOC = (body: string, head = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

beforeEach(() => {
  resetSelfContainCache();
});

describe('script のインライン展開', () => {
  it('配信ルートに解決される src を本文へ展開し、src 属性を除く', async () => {
    const fetcher = fetcherFor({ 'js/table.js': 'console.log(1)' });
    const out = await selfContainPreviewDoc(DOC('<script src="../js/table.js"></script>'), fetcher);
    expect(out).toContain('<script>');
    expect(out).toContain('console.log(1)');
    expect(out).not.toContain('src=');
  });

  it('本文中の </script は <\\/ へ中和される(要素の早期終端を防ぐ)', async () => {
    const fetcher = fetcherFor({ 'js/x.js': 'var s="</script><img src=x>";' });
    const out = await selfContainPreviewDoc(DOC('<script src="../js/x.js"></script>'), fetcher);
    expect(out).toContain('<\\/script><img');
    expect(out).not.toContain('"</script><img');
  });

  it('<!-- を含む本文は展開しない(script data の二重エスケープ、fail closed)', async () => {
    const fetcher = fetcherFor({ 'js/x.js': '<!-- if(a<b){} -->' });
    const src = DOC('<script src="../js/x.js"></script>');
    const out = await selfContainPreviewDoc(src, fetcher);
    expect(out).toContain('src="../js/x.js"');
  });

  it('配信ルートへ解決されない参照(絶対 URL・ルート外)は原文のまま', async () => {
    const fetcher = fetcherFor({});
    const out = await selfContainPreviewDoc(DOC('<script src="../../etc/x.js"></script>'), fetcher);
    // DOMPurify 通過後も src が残る = 展開対象にならず fetch も発生しない。
    expect(fetcher).not.toHaveBeenCalled();
    expect(out).toContain('src=');
  });

  it('未知属性つき script は展開しない(サーバ rebuildOpenTag と同じ許可リスト)', async () => {
    const fetcher = fetcherFor({ 'js/x.js': 'ok()' });
    const out = await selfContainPreviewDoc(
      DOC('<script src="../js/x.js" data-keep="1"></script>'),
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(out).toContain('src="../js/x.js"');
  });

  it('取得失敗(404)は原文のまま', async () => {
    const fetcher = fetcherFor({});
    const out = await selfContainPreviewDoc(
      DOC('<script src="../js/missing.js"></script>'),
      fetcher,
    );
    expect(out).toContain('src="../js/missing.js"');
  });
});

describe('フォントの data: URI 化', () => {
  it('style 内の url(../css/fonts/…) を data:font/… へ置き換える', async () => {
    const fetcher = fetcherFor({ 'css/fonts/biz.woff2': new Uint8Array([1, 2, 3]) });
    const out = await selfContainPreviewDoc(
      DOC('<p>x</p>', '<style>@font-face{font-family:a;src:url(../css/fonts/biz.woff2)}</style>'),
      fetcher,
    );
    expect(out).toContain('url(data:font/woff2;base64,AQID)');
    expect(out).not.toContain('url(../css/fonts/biz.woff2)');
  });

  it('旧配信パス fonts/ は埋め込まない', async () => {
    const fetcher = fetcherFor({ 'fonts/old.woff2': new Uint8Array([1]) });
    const out = await selfContainPreviewDoc(
      DOC('', '<style>@font-face{src:url(fonts/old.woff2)}</style>'),
      fetcher,
    );
    expect(out).toContain('url(fonts/old.woff2)');
  });

  it('css/fonts/ 配下でない url() は触らない(css/ 画像や外部 URL)', async () => {
    const fetcher = fetcherFor({});
    const css = '@import url(../css/x.css);b{background:url(https://evil/x.png)}';
    const out = await selfContainPreviewDoc(DOC('<p>x</p>', `<style>${css}</style>`), fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(out).toContain('url(../css/x.css)');
  });

  it('CSS エスケープで書いた参照も同じ物差しで解決される(url(\\66 onts/…))', async () => {
    const fetcher = fetcherFor({ 'css/fonts/a.woff2': new Uint8Array([9]) });
    const out = await selfContainPreviewDoc(
      DOC('<p>x</p>', '<style>@font-face{src:url(../css/\\66 onts/a.woff2)}</style>'),
      fetcher,
    );
    expect(out).toContain('data:font/woff2;base64,');
  });
});

describe('キャッシュ', () => {
  it('同じ資産は 1 回しか fetch しない(2 回目の変換でも)', async () => {
    const fetcher = fetcherFor({ 'js/x.js': 'ok()' });
    const doc = DOC('<script src="../js/x.js"></script><script src="../js/x.js"></script>');
    await selfContainPreviewDoc(doc, fetcher);
    await selfContainPreviewDoc(doc, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('全体の fail closed', () => {
  it('空文書はそのまま返す', async () => {
    const fetcher = fetcherFor({});
    expect(await selfContainPreviewDoc('', fetcher)).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('上限・例外での fail closed', () => {
  it('上限を超える script / font と fetcher の例外は展開しない', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const out = await selfContainPreviewDoc(
      DOC('<script src="../js/big.js"></script>'),
      fetcherFor({ 'js/big.js': big }),
    );
    expect(out).toContain('src="../js/big.js"');

    const throwing = vi.fn(async () => {
      throw new Error('net');
    });
    expect(
      await selfContainPreviewDoc(DOC('<script src="../js/a.js"></script>'), throwing),
    ).toContain('src="../js/a.js"');
    expect(
      await selfContainPreviewDoc(
        DOC('', '<style>@font-face{src:url(../css/fonts/a.woff2)}</style>'),
        throwing,
      ),
    ).toContain('url(../css/fonts/a.woff2)');
  });

  it('font が上限バイト数を超えると展開しない', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const fetcher = fetcherFor({ 'css/fonts/big.woff2': big });
    const out = await selfContainPreviewDoc(
      DOC('', '<style>@font-face{src:url(../css/fonts/big.woff2)}</style>'),
      fetcher,
    );
    expect(out).toContain('url(../css/fonts/big.woff2)');
  });

  it('font は拡張子の許可リスト・404・上限で展開を諦め、同じ rel は 1 度しか取得しない', async () => {
    const fetcher = fetcherFor({ 'css/fonts/a.woff2': new Uint8Array([1, 2, 3]) });
    const css =
      '<style>@font-face{src:url(../css/fonts/a.woff2)} .x{src:url(../css/fonts/a.woff2)}</style>';
    const out = await selfContainPreviewDoc(DOC('', css), fetcher);
    expect(out.match(/data:font\/woff2;base64,/g)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await selfContainPreviewDoc(
        DOC('', '<style>@font-face{src:url(../css/fonts/a.xyz)}</style>'),
        fetcher,
      ),
    ).toContain('url(../css/fonts/a.xyz)');
    expect(
      await selfContainPreviewDoc(
        DOC('', '<style>@font-face{src:url(../css/fonts/missing.woff2)}</style>'),
        fetcher,
      ),
    ).toContain('url(../css/fonts/missing.woff2)');
  });

  it('type=module は展開し、許可外 type と src 無しの script、空の style は触らない', async () => {
    const fetcher = fetcherFor({ 'js/m.js': 'm()' });
    expect(
      await selfContainPreviewDoc(DOC('<script type="module" src="../js/m.js"></script>'), fetcher),
    ).toContain('<script type="module">m()');
    const ld = DOC(
      '<script type="application/ld+json" src="../js/m.js"></script><script>inline()</script><style></style>',
    );
    expect(await selfContainPreviewDoc(ld, fetcher)).toContain('src="../js/m.js"');
  });

  it('fetcher を省略すると window.fetch を使う', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('g()', { status: 200 })),
    );
    expect(await selfContainPreviewDoc(DOC('<script src="../js/g.js"></script>'))).toContain('g()');
    vi.unstubAllGlobals();
  });
});

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
  it('<img src="../images/…svg"> を data:image/svg+xml に置き換える(取得先は単体配信ルート)', async () => {
    const fetcher = fetcherForUrls({ [LOGO_URL]: LOGO_SVG });
    const out = await selfContainPreviewDoc(DOC('<img src="../images/510037_logo.svg">'), fetcher);
    expect(fetcher).toHaveBeenCalledWith(LOGO_URL);
    expect(out).toContain('src="data:image/svg+xml;base64,');
    expect(out).not.toContain('src="../images/');
  });

  it('png も data:image/png に置き換える', async () => {
    const fetcher = fetcherForUrls({
      '/api/fund-assets/images/510037_photo.png': new Uint8Array([0x89, 0x50]),
    });
    const out = await selfContainPreviewDoc(DOC('<img src="../images/510037_photo.png">'), fetcher);
    expect(out).toContain('src="data:image/png;base64,');
  });

  it('<style> 内の url(../images/…) を置き換える(付け替え後の引用形でも)', async () => {
    const fetcher = fetcherForUrls({ [LOGO_URL]: LOGO_SVG });
    const out = await selfContainPreviewDoc(
      DOC('<p class="a">x</p>', '<style>.a{background:url("../images/510037_logo.svg")}</style>'),
      fetcher,
    );
    expect(out).toContain('url(data:image/svg+xml;base64,');
  });

  it('違反 SVG(単体配信ルートが 404)は埋めず原文のまま', async () => {
    const fetcher = fetcherForUrls({});
    const out = await selfContainPreviewDoc(DOC('<img src="../images/510037_bad.svg">'), fetcher);
    expect(out).toContain('src="../images/510037_bad.svg"');
  });

  it('2 段以上の下・許可外拡張子・images 以外・文書直下基準・会社コード不明の会社フォルダは取りに行かない', async () => {
    const fetcher = fetcherForUrls({});
    await selfContainPreviewDoc(
      DOC(
        '<img src="../images/a/b/c.svg"><img src="../images/a.gif"><img src="../photos/a.png">' +
          '<img src="images/510037_logo.svg"><img src="../images/smtam/qr_code.svg">',
      ),
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('上限を超える画像は埋めない', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const fetcher = fetcherForUrls({ '/api/fund-assets/images/510037_big.png': big });
    const out = await selfContainPreviewDoc(DOC('<img src="../images/510037_big.png">'), fetcher);
    expect(out).toContain('src="../images/510037_big.png"');
  });

  it('同じ画像は 1 回しか取りに行かない', async () => {
    const fetcher = fetcherForUrls({ [LOGO_URL]: LOGO_SVG });
    const doc = DOC('<img src="../images/510037_logo.svg"><img src="../images/510037_logo.svg">');
    await selfContainPreviewDoc(doc, fetcher);
    await selfContainPreviewDoc(doc, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('共有の data: 許可リストは SVG を含まないまま(埋め込みが作る data: だけが例外)', () => {
    expect(isSelfContainedUrl('data:image/svg+xml;base64,AAAA')).toBe(false);
  });

  it('会社フォルダの画像は会社コードと大文字小文字の違いだけで一致するときだけ埋める', async () => {
    const QR = '/api/fund-assets/images/smtam/qr_code.svg';
    const fetcher = fetcherForUrls({ [QR]: LOGO_SVG });
    const doc = DOC('<img src="../images/smtam/qr_code.svg">');
    const other = await selfContainPreviewDoc(doc, fetcher, { companyCode: 'AM01' });
    expect(other).toContain('src="../images/smtam/qr_code.svg"');
    expect(fetcher).not.toHaveBeenCalled();
    const same = await selfContainPreviewDoc(doc, fetcher, { companyCode: 'SMTAM' });
    expect(fetcher).toHaveBeenCalledWith(QR);
    expect(same).toContain('src="data:image/svg+xml;base64,');
  });

  it('付け替え済みの本文 CSS(../css/fonts/…)と CSS 内の会社フォルダ画像も埋める', async () => {
    const QR = '/api/fund-assets/images/SMTAM/bg.svg';
    const fetcher = vi.fn(async (url: string): Promise<Response> => {
      if (url === QR) return new Response(LOGO_SVG, { status: 200 });
      if (url === '/api/preview-host/css/fonts/a.woff2') {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const css =
      '@font-face{src:url("../css/fonts/a.woff2")}.p{background:url("../images/SMTAM/bg.svg")}';
    const out = await selfContainPreviewDoc(
      DOC('<p class="p">x</p>', `<style>${css}</style>`),
      fetcher,
      {
        companyCode: 'smtam',
      },
    );
    expect(out).toContain('data:font/woff2;base64,');
    expect(out).toContain('url(data:image/svg+xml;base64,');
  });

  it('日本語名は部分ごとに符号化した URL で取り、符号化済みの参照も同じ URL で取る', async () => {
    const JA = '110024_基準価額等の推移.svg';
    const url = `/api/fund-assets/images/smtam/${encodeURIComponent(JA)}`;
    const fetcher = fetcherForUrls({ [url]: LOGO_SVG });
    const out = await selfContainPreviewDoc(
      DOC(`<img src="../images/smtam/${JA}"><img src="../images/smtam/${encodeURIComponent(JA)}">`),
      fetcher,
      { companyCode: 'SMTAM' },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(url);
    expect(out).not.toContain('src="../images/');
  });
});

describe('配信 URL の符号化', () => {
  /** 呼ばれた URL をそのまま記録し、常に 200 を返す fetcher。 */
  function recordingFetcher() {
    return vi.fn(async (_url: string): Promise<Response> => new Response('ok()', { status: 200 }));
  }

  it('復号後に %2e%2e となる部分は符号化して送り、別の API を指す URL にしない', async () => {
    const fetcher = recordingFetcher();
    await selfContainPreviewDoc(
      DOC('<script src="../js/%252e%252e/%252e%252e/auth/me"></script>'),
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledWith('/api/preview-host/js/%252e%252e/%252e%252e/auth/me');
    for (const [url] of fetcher.mock.calls) {
      expect(new URL(url, 'http://h').pathname.startsWith('/api/preview-host/js/')).toBe(true);
    }
  });

  it('名前の # ? % は符号化して送る(script と font)', async () => {
    const fetcher = recordingFetcher();
    await selfContainPreviewDoc(
      DOC(
        '<script src="../js/a%23b%3Fc%25d.js"></script>',
        '<style>@font-face{src:url(../css/fonts/f%23%3F%25.woff2)}</style>',
      ),
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledWith('/api/preview-host/js/a%23b%3Fc%25d.js');
    expect(fetcher).toHaveBeenCalledWith('/api/preview-host/css/fonts/f%23%3F%25.woff2');
  });

  it('普通の名前は今までどおりの URL で取る', async () => {
    const fetcher = recordingFetcher();
    await selfContainPreviewDoc(DOC('<script src="../js/app.js"></script>'), fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/preview-host/js/app.js');
  });

  it('符号化できない名前(対の無いサロゲート)はその参照だけ原文のまま、他の参照は埋める', async () => {
    const fetcher = fetcherFor({
      'js/ok.js': 'ok()',
      'css/fonts/ok.woff2': new Uint8Array([1]),
    });
    const out = await selfContainPreviewDoc(
      DOC(
        '<script src="../js/a\uD800.js"></script><script src="../js/ok.js"></script>',
        '<style>@font-face{src:url(../css/fonts/b\uD800.woff2)}' +
          '@font-face{src:url(../css/fonts/ok.woff2)}</style>',
      ),
      fetcher,
    );
    expect(out).toContain('ok()');
    expect(out).toContain('url(data:font/woff2;base64,AQ==)');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('解いたパスが接頭辞の下から動く URL は作らない', () => {
    expect(assetUrl('js/../../auth/me')).toBeUndefined();
    expect(assetUrl('js/./x.js')).toBeUndefined();
    expect(assetUrl('js/a\uD800.js')).toBeUndefined();
    expect(assetUrl('js/x.js')).toBe('/api/preview-host/js/x.js');
  });
});
