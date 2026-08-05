// =============================================================================
// previewSelfContain.test.ts — プレビュー文書の自己完結化(子の要求ゼロ化)
// =============================================================================
// 認証オン配備では opaque オリジンの子フレームの要求にセッション cookie が付かない
// (SameSite=Lax)。ここで検証するのは「親が取得して埋める」変換の 3 性質:
//   1. 展開される — 配信ルートに解決される script src / fonts url() は文書へ埋まる
//   2. fail closed — 展開できない形は**原文のまま**残る(文書破壊に倒れない)
//   3. 取得はキャッシュされる — 再描画のたびに同じ資産を fetch しない
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSelfContainCache, selfContainPreviewDoc } from '../src/lib/previewSelfContain';

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
    const out = await selfContainPreviewDoc(DOC('<script src="js/table.js"></script>'), fetcher);
    expect(out).toContain('<script>');
    expect(out).toContain('console.log(1)');
    expect(out).not.toContain('src=');
  });

  it('本文中の </script は <\\/ へ中和される(要素の早期終端を防ぐ)', async () => {
    const fetcher = fetcherFor({ 'js/x.js': 'var s="</script><img src=x>";' });
    const out = await selfContainPreviewDoc(DOC('<script src="js/x.js"></script>'), fetcher);
    expect(out).toContain('<\\/script><img');
    expect(out).not.toContain('"</script><img');
  });

  it('<!-- を含む本文は展開しない(script data の二重エスケープ、fail closed)', async () => {
    const fetcher = fetcherFor({ 'js/x.js': '<!-- if(a<b){} -->' });
    const src = DOC('<script src="js/x.js"></script>');
    const out = await selfContainPreviewDoc(src, fetcher);
    expect(out).toContain('src="js/x.js"');
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
      DOC('<script src="js/x.js" data-keep="1"></script>'),
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(out).toContain('src="js/x.js"');
  });

  it('取得失敗(404)は原文のまま', async () => {
    const fetcher = fetcherFor({});
    const out = await selfContainPreviewDoc(DOC('<script src="js/missing.js"></script>'), fetcher);
    expect(out).toContain('src="js/missing.js"');
  });
});

describe('フォントの data: URI 化', () => {
  it('style 内の url(fonts/…) を data:font/… へ置き換える', async () => {
    const fetcher = fetcherFor({ 'fonts/biz.woff2': new Uint8Array([1, 2, 3]) });
    const out = await selfContainPreviewDoc(
      DOC('<p>x</p>', '<style>@font-face{font-family:a;src:url(fonts/biz.woff2)}</style>'),
      fetcher,
    );
    expect(out).toContain('url(data:font/woff2;base64,AQID)');
    expect(out).not.toContain('url(fonts/biz.woff2)');
  });

  it('fonts/ 配下でない url() は触らない(css/ 画像や外部 URL)', async () => {
    const fetcher = fetcherFor({});
    const css = '@import url(css/x.css);b{background:url(https://evil/x.png)}';
    const out = await selfContainPreviewDoc(DOC('<p>x</p>', `<style>${css}</style>`), fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(out).toContain('url(css/x.css)');
  });

  it('CSS エスケープで書いた参照も同じ物差しで解決される(url(\\66 onts/…))', async () => {
    const fetcher = fetcherFor({ 'fonts/a.woff2': new Uint8Array([9]) });
    const out = await selfContainPreviewDoc(
      DOC('<p>x</p>', '<style>@font-face{src:url(\\66 onts/a.woff2)}</style>'),
      fetcher,
    );
    expect(out).toContain('data:font/woff2;base64,');
  });
});

describe('キャッシュ', () => {
  it('同じ資産は 1 回しか fetch しない(2 回目の変換でも)', async () => {
    const fetcher = fetcherFor({ 'js/x.js': 'ok()' });
    const doc = DOC('<script src="js/x.js"></script><script src="js/x.js"></script>');
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
