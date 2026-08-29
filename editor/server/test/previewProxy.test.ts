// =============================================================================
// previewProxy.test.ts — 中継パスの許可リスト(主防御)と CSP(多層防御)
// =============================================================================
// 前回のテストは「正しい入力が通ること」に寄っていて迂回を検出できなかった。ここでは
// **迂回入力が転送されないこと**を主張する形に寄せる。`/@fs` や `/__open-in-editor` は
// 「危険なので拒否リストに入れた」のではなく「許可リストに載らないので落ちる」ことを
// テストが示す — 列挙ではなく設計で落ちていることの証跡である。
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowForwardPath,
  type ForwardPath,
  previewSecurityHeaders,
  proxyToPreview,
} from '../src/vivliostyle/previewProxy.js';

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop() as http.Server;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** ループバックで listen し、実ポートを返す。 */
async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

/** 許可リストを通った前提のパス(CSP / proxy 単体テスト用の brand 付与)。 */
const fp = (p: string): ForwardPath => p as ForwardPath;

describe('allowForwardPath — 転送してよいパスを数える', () => {
  const BASE = '/vivliostyle';

  it.each([
    // Vite の内部エンドポイント。これらは列挙して拒否したのではなく、許可リストに
    // 載らないので落ちる(`/@fs` は TLS 秘密鍵まで読める最重要経路だった)。
    '/@fs/C:/Users/caads/workspace/editor/server/tls/editor.pfx',
    '/@fs/C:/Users/caads/workspace/editor/server/tls/editor.pfx.pass',
    '/@id/x',
    '/@vite/client',
    '/@vivliostyle:viewer:client',
    '/node_modules/evil.html',
    '/node_modules/.vite/deps/x.js',
    // サーバ上のエディタプロセスを起動する Vite のミドルウェア。
    '/__open-in-editor?file=C:/x.js:1:1',
    '/__vite_ping',
    // 境界なし前方一致を狙う(展開ルート直下の兄弟ディレクトリ)。
    '/vivliostyle-evil/x.html',
    '/__vivliostyle-viewer-evil/x.html',
    // 二重スラッシュ。ここで「先頭 // を潰してから判定」する実装にすると逆に穴になる。
    '//@fs/C:/x',
    // 復号後の `..`。
    '/vivliostyle/%2e%2e/%2e%2e/@fs/C:/x',
    // セグメント境界の偽装。
    '/vivliostyle%2f..%2f@fs/C:/x',
    '/vivliostyle%5c..%5c@fs',
    // 生バックスラッシュ・空白・制御文字は文字集合で落ちる。
    '/vivliostyle/..\\..\\@fs',
    '/vivliostyle/a b.html',
    // 生前方一致を外す percent-encoding(上流の decodeURI には届く形)。
    '/%76ivliostyle/x.html',
    '/%40fs/C:/x',
    '/%5F%5Fvivliostyle-viewer/index.html',
    // 復号不能。
    '/%E0%A4%A/x.html',
    // 絶対形リクエストライン・先頭 / なし。
    'http://evil.example/x',
    '@fs/x',
    '',
    // base 外の素のパス。
    '/docs/index.html',
  ])('拒否する: %s', (p) => {
    expect(allowForwardPath(p, BASE)).toBeUndefined();
  });

  it.each([
    '/',
    '/__vivliostyle-viewer',
    '/__vivliostyle-viewer/index.html',
    '/__vivliostyle-viewer/js/vivliostyle-viewer.js',
    '/__vivliostyle-viewer/css/ui.menu-bar.css',
    '/__vivliostyle-viewer/fonts/fa-solid-900.woff2',
    '/vivliostyle/index.html',
    '/vivliostyle/style.css?v=1',
    '/vivliostyle/index.html#page=2',
    // 日本語ファイル名(正常系。percent-encoding は復号後も base 配下に留まる)。
    '/vivliostyle/%E6%97%A5%E6%9C%AC%E8%AA%9E.html',
  ])('許可する: %s', (p) => {
    expect(allowForwardPath(p, BASE)).toBe(p);
  });

  it('docBase が変われば許可される集合も入れ替わる(表を反転して主張する)', () => {
    expect(allowForwardPath('/docs/index.html', '/docs')).toBe('/docs/index.html');
    expect(allowForwardPath('/vivliostyle/index.html', '/docs')).toBeUndefined();
    // ビューア資産は docBase に依らず常に通る。
    expect(allowForwardPath('/__vivliostyle-viewer/index.html', '/docs')).toBeTruthy();
  });

  it('通した文字列は 1 文字も書き換えない(検査した形と転送する形を一致させる)', () => {
    const p = '/vivliostyle/a/../a/x.css?v=1#f';
    // `..` を含むので拒否。ここで「正規化して通す」実装にすると、検査した形と上流が
    // 解釈する形が分岐して次の迂回になる。
    expect(allowForwardPath(p, BASE)).toBeUndefined();
    expect(allowForwardPath('/vivliostyle/x.css?a=%2f', BASE)).toBe('/vivliostyle/x.css?a=%2f');
  });
});

describe('previewSecurityHeaders', () => {
  it('forbids inline and eval scripts on uploaded document paths', () => {
    const csp = previewSecurityHeaders(fp('/vivliostyle/index.html'))['content-security-policy'];
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    // `unsafe-inline` は style だけ(組版はインラインスタイルに依存する)。script には無い。
    expect(csp).toContain("style-src 'self' 'unsafe-inline' data:");
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false);
  });

  // ビューアは knockout の data-bind 式を組み立てるため eval が要る。だが inline script は
  // 不要(index.html も Vite 注入分も外部 script)なので、そこは許さない。
  it('allows the viewer app its scripts but never inline script', () => {
    const csp = previewSecurityHeaders(fp('/__vivliostyle-viewer/index.html'))[
      'content-security-policy'
    ];
    expect(csp).toContain("script-src 'self' 'unsafe-eval' blob:");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  // `/@` や `/node_modules/` を「ビューア側」に列挙すると緩い CSP を与えてしまう。
  // それらはそもそも転送されないので、viewer プロファイルが当たるのはビューア配下だけ。
  it('viewer プロファイルが当たるのはビューア配下だけ', () => {
    for (const p of ['/', '/vivliostyle/index.html', '/vivliostyle/index.html?x=1']) {
      expect(previewSecurityHeaders(fp(p))['content-security-policy'], p).toContain(
        "script-src 'none'",
      );
    }
    expect(
      previewSecurityHeaders(fp('/__vivliostyle-viewer/index.html'))['content-security-policy'],
    ).toContain("'unsafe-eval'");
  });

  it('keeps the viewer profile for viewer paths that carry a query string', () => {
    const csp = previewSecurityHeaders(fp('/__vivliostyle-viewer/index.html?src=x#p=1'))[
      'content-security-policy'
    ];
    expect(csp).toContain("'unsafe-eval'");
  });

  it('always sends nosniff', () => {
    for (const p of ['/vivliostyle/a.html', '/__vivliostyle-viewer/index.html']) {
      expect(previewSecurityHeaders(fp(p))['x-content-type-options']).toBe('nosniff');
    }
  });
});

describe('proxyToPreview', () => {
  it('overrides an upstream CSP and streams the body through', async () => {
    const upstream = await listen((_req, res) => {
      // 上流(Vite)が緩い CSP を返しても、プロキシ側の指定が勝たなければ意味がない。
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', "script-src 'unsafe-inline'");
      res.end('<p>preview</p>');
    });
    const port = await listen((req, res) => {
      proxyToPreview('127.0.0.1', upstream, fp(req.url ?? '/'), req, res);
    });

    const res = await fetch(`http://127.0.0.1:${port}/vivliostyle/index.html`);
    expect(await res.text()).toBe('<p>preview</p>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('上流の CORS ヘッダ・cookie・実装情報を素通ししない', async () => {
    // Vite の dev サーバは既定で CORS 有効。素通しすると別 origin から読める。
    const upstream = await listen((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('set-cookie', 'evil=1');
      res.setHeader('x-powered-by', 'Express');
      res.end('ok');
    });
    const port = await listen((req, res) => {
      proxyToPreview('127.0.0.1', upstream, fp(req.url ?? '/'), req, res);
    });
    const res = await fetch(`http://127.0.0.1:${port}/vivliostyle/x`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/plain');
  });

  it('アプリのセッション cookie を上流へ渡さない', async () => {
    let seen: http.IncomingHttpHeaders | undefined;
    const upstream = await listen((req, res) => {
      seen = req.headers;
      res.end('ok');
    });
    const port = await listen((req, res) => {
      proxyToPreview('127.0.0.1', upstream, fp(req.url ?? '/'), req, res);
    });
    await fetch(`http://127.0.0.1:${port}/vivliostyle/x`, {
      headers: { cookie: 'sid=secret', accept: 'text/html' },
    });
    expect(seen?.cookie).toBeUndefined();
    expect(seen?.accept).toBe('text/html');
  });

  it('リクエストは常に end される(消費済みストリームを pipe しない)', async () => {
    // 非 GET を `req.pipe(upstream)` で流す形は、Fastify の content-type parser が
    // 先にボディを Buffer 化するため 1 バイトも流れず `end()` も呼ばれず、上流が宙吊りに
    // なってソケットとメモリが滞留する。ルートが GET/HEAD しか登録しないうえ、
    // proxy 側も常に end する。
    const upstream = await listen((req, res) => {
      req.resume();
      req.on('end', () => res.end(`${req.method}:ok`));
    });
    const port = await listen((req, res) => {
      proxyToPreview('127.0.0.1', upstream, fp(req.url ?? '/'), req, res);
    });
    const res = await fetch(`http://127.0.0.1:${port}/vivliostyle/x`, {
      method: 'POST',
      body: 'zoom=2',
    });
    expect(await res.text()).toBe('POST:ok');
  });

  it('answers 502 when the preview server is gone', async () => {
    // 使われていないポートへ向ける(listen 直後に close して確実に空きにする)。
    const dead = await listen(() => undefined);
    const server = servers.pop() as http.Server;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const port = await listen((req, res) => {
      proxyToPreview('127.0.0.1', dead, fp(req.url ?? '/'), req, res);
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(502);
    expect((await res.json()).kind).toBe('network');
  });
});
