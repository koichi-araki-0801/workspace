// =============================================================================
// previewHost.test.ts — プレビュー隔離ビューアの経路専用 CSP と資産配信の封じ込め
// =============================================================================
// 主張は 3 つ。
//   1. ホストページ応答の CSP が**この経路だけ**緩い(全域 CSP は据え置き)。緩和が漏れると
//      SPA 本体の script 注入防御が落ちるので、対照ルートで漏れていないことも見る。
//   2. 同梱資産の配信が許可リストの中に閉じている。迂回入力(`..`・絶対 URL・許可外拡張子・
//      許可外の置き場)で **1 バイトも外へ出ない**ことを主張する。
//   3. ホストページが利用者入力を 1 バイトも含まない定数であること(テンプレ本文は
//      postMessage で渡す設計の裏返し)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-preview-host-'));
// 資産の置き場を temp へ寄せる(`config` は import 時に env を読む)。
process.env.DATA_ROOT = tmp;
process.env.ASSETS_DIR = path.join(tmp, 'assets');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.AUTH_REQUIRED = 'false';

let app: FastifyInstance;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, 'assets', 'js'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'assets', 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'assets', 'js', 'app.js'), 'window.FIT=1;', 'utf8');
  // 許可外拡張子。同じ置き場でも配ってはならない。
  fs.writeFileSync(path.join(tmp, 'assets', 'js', 'secret.env'), 'TOKEN=zz', 'utf8');
  fs.writeFileSync(path.join(tmp, 'css', '510037.css'), 'body{}', 'utf8');
  // 配信面の外(dataRoot 直下)。`..` で辿れないことの標的。
  fs.writeFileSync(path.join(tmp, 'outside.js'), 'LEAK', 'utf8');

  const { buildCspDirectives } = await import('../src/config.js');
  const { previewHostRoutes } = await import('../src/vivliostyle/previewHost.js');
  app = Fastify();
  app.decorateRequest('user', undefined);
  // `app.ts` と同じ順序: helmet(全域)→ ルート。経路専用 CSP は onSend で上書きする。
  app.register(helmet, {
    contentSecurityPolicy: { useDefaults: true, directives: buildCspDirectives([]) },
  });
  app.register(previewHostRoutes, { prefix: '/api' });
  // 緩和が漏れていないことの対照。
  app.get('/api/health', async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('GET /api/preview-host/index.html', () => {
  it('経路専用 CSP でテンプレの inline JS を許す', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview-host/index.html' });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    // 全域 CSP(ハッシュのみ)が残っていると子の inline script が全部落ちる = 退行。
    expect(/script-src[^;]*sha256-/.test(csp)).toBe(false);
    // 隔離の要: 外向き通信先を増やさない・埋め込み元をアプリ自身に限る。
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/https?:\/\//);
    // core は表セル・脚注用の内蔵 user-agent.xml を `data:application/xml,…` の XHR で読む。
    // connect-src から data: を外すと、表を含む帳票の組版が loading のまま恒久停止する
    // (実測 5/5 再現)。退行網は e2e(smoke.spec.ts の直行テスト)と二重。
    expect(csp).toMatch(/connect-src[^;]*data:/);
  });

  it('緩和はこの経路だけに閉じている(他ルートは全域 CSP のまま)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = res.headers['content-security-policy'] as string;
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false);
  });

  it('ページは定数で、テンプレ本文を 1 バイトも含まない(文書は postMessage で渡す)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview-host/index.html' });
    // ビューアバンドルはページへ**内蔵**する。opaque オリジンの子のサブリソース要求には
    // SameSite=Lax のセッション cookie が付かず、`<script src>` は認証オン配備で 401 に
    // なる(実測)。内蔵ならネットワーク要求自体が無い。
    expect(res.body).toContain('window.Vivliostyle=');
    expect(res.body).not.toContain('<script src="vivliostyle.js">');
    expect(res.body).toContain('editor:preview-doc');
    // 定数であることの機械的な言い方: 何度取っても同じバイト列(リクエスト由来の値が
    // 1 つも埋まらない)。ここに利用者入力が混ざる形へ変えると、経路専用 CSP の
    // `'unsafe-inline'` がそのまま注入面になる。
    const again = await app.inject({
      method: 'GET',
      url: '/api/preview-host/index.html?html=<img src=x onerror=alert(1)>',
    });
    expect(again.body).toBe(res.body);
  });
});

describe('GET /api/preview-host/* — 同梱資産の配信', () => {
  it('許可リスト配下の資産を配る', async () => {
    const js = await app.inject({ method: 'GET', url: '/api/preview-host/js/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.body).toBe('window.FIT=1;');
    expect(js.headers['content-type']).toContain('text/javascript');
    const css = await app.inject({ method: 'GET', url: '/api/preview-host/css/510037.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('迂回入力は 404 で、本文を 1 バイトも出さない', async () => {
    const cases = [
      // 置き場の外(`..` の遡上。素の形と URL エンコード形の両方)
      '/api/preview-host/js/../../outside.js',
      '/api/preview-host/js/%2e%2e/%2e%2e/outside.js',
      // 許可外の拡張子(同じ置き場でも配らない)
      '/api/preview-host/js/secret.env',
      // 許可外の置き場
      '/api/preview-host/templates/x.js',
      // ルート絶対・絶対 URL(解決器が undefined を返す形)
      '/api/preview-host//etc/passwd',
      '/api/preview-host/https://evil.example/x.js',
    ];
    for (const url of cases) {
      const res = await app.inject({ method: 'GET', url });
      expect([404, 400], `${url} → ${res.statusCode}`).toContain(res.statusCode);
      expect(res.body, `${url} が本文を返した`).not.toContain('LEAK');
      expect(res.body, `${url} が本文を返した`).not.toContain('TOKEN=');
    }
  });
});
