import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { previewSecurityHeaders, proxyToPreview } from '../src/vivliostyle/previewProxy.js';

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

describe('previewSecurityHeaders', () => {
  it('forbids inline and eval scripts on uploaded document paths', () => {
    const csp = previewSecurityHeaders('/vivliostyle/index.html')['content-security-policy'];
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    // `unsafe-inline` は style だけ(組版はインラインスタイルに依存する)。script には無い。
    expect(csp).toContain("style-src 'self' 'unsafe-inline' data:");
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false);
  });

  // ビューアは knockout の data-bind 式を組み立てるため eval が要る。だが inline script は
  // 不要(index.html も Vite 注入分も外部 script)なので、そこは許さない。
  it('allows the viewer app its scripts but never inline script', () => {
    const csp = previewSecurityHeaders('/__vivliostyle-viewer/index.html')[
      'content-security-policy'
    ];
    expect(csp).toContain("script-src 'self' 'unsafe-eval' blob:");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('gives the viewer profile only to the viewer app and Vite internals', () => {
    for (const p of [
      '/__vivliostyle-viewer/index.html',
      '/@vivliostyle:viewer:client',
      '/@vite/client',
      '/node_modules/.vite/deps/x.js',
    ]) {
      expect(previewSecurityHeaders(p)['content-security-policy'], p).toContain("'unsafe-eval'");
    }
  });

  // 判定は fail-close。ここを「未知はビューア扱い」に戻すと、文書の配信先をずらすだけで
  // `'unsafe-eval'` の側へ逃げられる(アップロード config の `base` / percent-encoding)。
  it('falls back to the content profile for anything else', () => {
    for (const p of [
      '/',
      // アップロード zip の `vivliostyle.config.json` が `base` を変えた場合。
      '/docs/index.html',
      '/vivliostyle/index.html?x=1',
      // upstream は `decodeURI(req.url)` で照合するので、この URL でも文書が返る。
      '/%76ivliostyle/index.html',
      '/%64ocs/evil.html',
      // 復号できない入力・ビューア path を装った encode も、すべて厳しい方へ倒す。
      '/%E0%A4%A/x.html',
      '/%5F%5Fvivliostyle-viewer/index.html',
      // `base` を `/%40x` にすると decodeURIComponent 後は `/@x/...` に見える(復号して
      // 照合すると誤ってビューア扱いになる形)。
      '/%40x/evil.html',
    ]) {
      expect(previewSecurityHeaders(p)['content-security-policy'], p).toContain(
        "script-src 'none'",
      );
    }
  });

  it('keeps the viewer profile for viewer paths that carry a query string', () => {
    const csp = previewSecurityHeaders('/__vivliostyle-viewer/index.html?src=x#p=1')[
      'content-security-policy'
    ];
    expect(csp).toContain("'unsafe-eval'");
  });

  it('always sends nosniff', () => {
    for (const p of ['/vivliostyle/a.html', '/__vivliostyle-viewer/index.html']) {
      expect(previewSecurityHeaders(p)['x-content-type-options']).toBe('nosniff');
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
      proxyToPreview('127.0.0.1', upstream, req.url ?? '/', req, res);
    });

    const res = await fetch(`http://127.0.0.1:${port}/vivliostyle/index.html`);
    expect(await res.text()).toBe('<p>preview</p>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  // GET/HEAD 以外はリクエストボディを上流へ流す(ビューアは設定変更などで POST を出す)。
  // ここを `upstream.end()` に倒すと本文が落ちてプレビューが無言で壊れるため、実ボディで固定する。
  it('pipes the request body upstream for non-GET methods', async () => {
    const upstream = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(`${req.method}:${Buffer.concat(chunks).toString('utf8')}`);
      });
    });
    const port = await listen((req, res) => {
      proxyToPreview('127.0.0.1', upstream, req.url ?? '/', req, res);
    });

    const res = await fetch(`http://127.0.0.1:${port}/__vivliostyle-viewer/settings`, {
      method: 'POST',
      body: 'zoom=2',
    });
    expect(await res.text()).toBe('POST:zoom=2');
    expect(res.headers.get('content-security-policy')).toContain("'unsafe-eval'");
  });

  it('answers 502 when the preview server is gone', async () => {
    // 使われていないポートへ向ける(listen 直後に close して確実に空きにする)。
    const dead = await listen(() => undefined);
    const server = servers.pop() as http.Server;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const port = await listen((req, res) => {
      proxyToPreview('127.0.0.1', dead, req.url ?? '/', req, res);
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(502);
    expect((await res.json()).kind).toBe('network');
  });
});
