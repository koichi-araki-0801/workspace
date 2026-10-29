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
import {
  PREVIEW_MARK_COLORS,
  PREVIEW_MAX_PART_KEYS,
  PREVIEW_MSG_MARKS,
  PREVIEW_MSG_PART_CLICK,
  PREVIEW_MSG_PART_PAGES,
  parsePreviewDocSeq,
  parsePreviewMarks,
  REVIEW_GHOST_ATTR,
  REVIEW_GHOST_TEXT,
  REVIEW_KEEP_ATTR,
  REVIEW_KEEP_TEXT,
  REVIEW_NO_ATTR,
} from '@editor/shared';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundleSafeToInline } from '../src/util/inlineBundle.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-preview-host-'));
// 資産の置き場を temp へ寄せる(`config` は import 時に env を読む)。
process.env.DATA_ROOT = tmp;
process.env.JS_DIR = path.join(tmp, 'js');
process.env.CSS_DIR = path.join(tmp, 'css');
process.env.IMAGES_DIR = path.join(tmp, 'images');
process.env.AUTH_REQUIRED = 'false';

let app: FastifyInstance;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, 'js'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'css', 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'css'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'images'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'images', '950037_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    'utf8',
  );
  fs.writeFileSync(path.join(tmp, 'js', 'app.js'), 'window.FIT=1;', 'utf8');
  // 許可外拡張子。同じ置き場でも配ってはならない。
  fs.writeFileSync(path.join(tmp, 'js', 'secret.env'), 'TOKEN=zz', 'utf8');
  fs.writeFileSync(path.join(tmp, 'css', '950037.css'), 'body{}', 'utf8');
  fs.writeFileSync(path.join(tmp, 'css', 'A_1_交付版.css'), 'body{}', 'utf8');
  // URL で意味を持つ字を含むフォント名(ルートの引数は復号済みなので、字面のまま実体を引く)。
  fs.writeFileSync(path.join(tmp, 'css', 'fonts', 'a#b.woff2'), 'FONT_HASH', 'utf8');
  fs.writeFileSync(path.join(tmp, 'css', 'fonts', '100%.woff2'), 'FONT_PCT', 'utf8');
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

  it('ホストページは目印のメッセージ種別と色を埋め、利用者の文字列を含まない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/preview-host/index.html' });
    for (const s of [
      PREVIEW_MSG_MARKS,
      PREVIEW_MSG_PART_CLICK,
      PREVIEW_MSG_PART_PAGES,
      PREVIEW_MARK_COLORS.pending,
      PREVIEW_MARK_COLORS.approved,
      '#c0392b',
      REVIEW_NO_ATTR,
      REVIEW_GHOST_ATTR,
      REVIEW_KEEP_ATTR,
      REVIEW_KEEP_TEXT,
    ]) {
      // ページは 765KB あるので、失敗時に本文を全部出さない形で比べる。
      expect(res.body.includes(s), s).toBe(true);
    }
    // 目印を足しても、要求に含めた文字列はページへ入らない(定数のまま)。
    const again = await app.inject({
      method: 'GET',
      url: '/api/preview-host/index.html?part=<script>alert(1)</script>',
    });
    expect(again.body).toBe(res.body);
    expect(again.body).not.toContain('alert(1)');
    // ブートスクリプトは文字列で組むので、構文が壊れても型検査では気づけない。最後の
    // `<script>` を関数本体として解釈できることを確かめる。
    const boot = res.body.slice(
      res.body.lastIndexOf('<script>') + 8,
      res.body.lastIndexOf('</script>'),
    );
    expect(boot).toContain('editor:preview-marks');
    expect(() => new Function(boot)).not.toThrow();
    expect(boot).toContain(REVIEW_GHOST_TEXT.rejectedAdded);
  });

  it('ブートスクリプトの marks の検査は shared の parsePreviewMarks と同じ入力に同じ答えを返す', async () => {
    const { BOOT_MARKS_PARSER } = await import('../src/vivliostyle/previewHost.js');
    // 子の中と同じ文字列を評価して、閉じた関数を取り出す。
    const hostParse = new Function(`${BOOT_MARKS_PARSER}\nreturn parseMarks;`)() as (
      v: unknown,
    ) => unknown;
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 'pending']));
    const base = { states: { '1': 'approved', '23': 'rejected' }, selected: '1', visible: true };
    const table: unknown[] = [
      base,
      { states: {}, selected: null, visible: false },
      { ...base, states: { '1': 'pending', '99999': 'approved' } },
      { ...base, states: { '0': 'pending' } },
      { ...base, selected: '0' },
      { ...base, states: { x: 'approved' } },
      { ...base, states: { '01': 'approved' } },
      { ...base, states: { '123456': 'approved' } },
      { ...base, states: { '1': 'held' } },
      { ...base, states: { '1': null } },
      { ...base, states: JSON.parse('{"__proto__":"approved"}') },
      { ...base, states: [] },
      { ...base, states: null },
      { ...base, selected: 'x' },
      { ...base, selected: '01' },
      { ...base, selected: 1 },
      { ...base, selected: undefined },
      { ...base, visible: 'yes' },
      { ...base, states: many(PREVIEW_MAX_PART_KEYS) },
      { ...base, states: many(PREVIEW_MAX_PART_KEYS + 1) },
      null,
      undefined,
      [],
      'marks',
      1,
    ];
    // 番号は 1 から振るので '0' は両方とも拒む(1 始まりの規則が子にも入っていること)。
    expect(hostParse({ ...base, states: { '0': 'pending' } })).toBeNull();
    expect(hostParse({ ...base, selected: '0' })).toBeNull();
    // 子の関数は states を null prototype で作るので、JSON を通して形だけを比べる。
    const norm = (v: unknown) => (v === null ? null : JSON.parse(JSON.stringify(v)));
    for (const [i, input] of table.entries()) {
      expect(norm(hostParse(input)), `#${i}`).toEqual(norm(parsePreviewMarks(input)));
    }
    // 表が「通る」側と「拒む」側の両方を含むこと(どちらかに偏ると比べた意味が無い)。
    const accepted = table.filter((v) => parsePreviewMarks(v) !== null).length;
    expect(accepted).toBeGreaterThanOrEqual(4);
    expect(accepted).toBeLessThan(table.length);
  });

  it('ブートスクリプトの文書の番号の検査は shared の parsePreviewDocSeq と同じ答えを返す', async () => {
    const { BOOT_MARKS_PARSER } = await import('../src/vivliostyle/previewHost.js');
    const hostParse = new Function(`${BOOT_MARKS_PARSER}
return parseDocSeq;`)() as (v: unknown) => unknown;
    const table: unknown[] = [
      0,
      1,
      42,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1',
      null,
      undefined,
      {},
    ];
    for (const [i, input] of table.entries()) {
      expect(hostParse(input), `#${i}`).toEqual(parsePreviewDocSeq(input));
    }
    const accepted = table.filter((v) => parsePreviewDocSeq(v) !== null).length;
    expect(accepted).toBe(4);
  });
});

describe('GET /api/preview-host/* — 同梱資産の配信', () => {
  it('受けるのは論理ルート相対のパス(親が文書基準の参照を解いてから取りに来る)', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/api/preview-host/css/${encodeURIComponent('A_1_交付版.css')}`,
    });
    expect(ok.statusCode).toBe(200);
    // 文書基準の形(`../css/…`)をそのまま渡しても論理ルートの外 = 配らない。
    const raw = await app.inject({
      method: 'GET',
      url: `/api/preview-host/doc/..%2F..%2Fcss/${encodeURIComponent('A_1_交付版.css')}`,
    });
    expect([400, 404]).toContain(raw.statusCode);
  });

  it('許可リスト配下の資産を配る', async () => {
    const js = await app.inject({ method: 'GET', url: '/api/preview-host/js/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.body).toBe('window.FIT=1;');
    expect(js.headers['content-type']).toContain('text/javascript');
    const css = await app.inject({ method: 'GET', url: '/api/preview-host/css/950037.css' });
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
      // 復号済みの引数に残る危険な字(NUL・`\`・ドライブ指定・UNC)
      '/api/preview-host/js/app.js%00',
      '/api/preview-host/js%5C..%5C..%5Coutside.js',
      '/api/preview-host/C%3A/outside.js',
      '/api/preview-host/%5C%5Chost%5Cshare/outside.js',
      // 末尾の `.`・空白(Windows で別の名前へ読み替わる)
      '/api/preview-host/js/app.js.',
      '/api/preview-host/js/app.js%20',
      // 二重符号化の `..` は字面の名前として探して無い
      '/api/preview-host/js/%252e%252e/%252e%252e/outside.js',
    ];
    for (const url of cases) {
      const res = await app.inject({ method: 'GET', url });
      expect([404, 400], `${url} → ${res.statusCode}`).toContain(res.statusCode);
      expect(res.body, `${url} が本文を返した`).not.toContain('LEAK');
      expect(res.body, `${url} が本文を返した`).not.toContain('TOKEN=');
    }
  });

  it('# や % を含むフォント名を返す(引数を切らず、もう一度は復号しない)', async () => {
    for (const [name, body] of [
      ['a#b.woff2', 'FONT_HASH'],
      ['100%.woff2', 'FONT_PCT'],
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/preview-host/css/fonts/${encodeURIComponent(name)}`,
      });
      expect(res.statusCode, name).toBe(200);
      expect(res.body).toBe(body);
    }
  });

  it('images/ は配らない(画像の配信経路は /api/fund-assets/images/ の 1 本)', async () => {
    for (const url of [
      '/api/preview-host/images/950037_logo.svg',
      '/api/preview-host/Images/950037_logo.svg',
      '/api/preview-host/images/xxam/qr.svg',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('<svg');
    }
  });
});

describe('bundleSafeToInline', () => {
  it('</script を含む bundle は inline にしない(要素の早期終端)', () => {
    expect(bundleSafeToInline('var s="</script>";')).toBe(false);
  });

  it('<!-- の後に <script が来る形は inline にしない(script data の二重エスケープ)', () => {
    expect(bundleSafeToInline('/*<!-- x */ var a="<script>";')).toBe(false);
    // <!-- が閉じてから <script が現れる形は、その後にもう対応する <!-- が無いので
    // 「コメントが閉じる前に <script が現れる」に当たらない = inline してよい。
    expect(bundleSafeToInline('/*<!-- x --> */ var a="<script>";')).toBe(true);
  });

  it('<!-- が閉じられて <script を含まない・そもそも無い bundle は inline できる', () => {
    expect(bundleSafeToInline('/*<!-- x -->*/ var a=1;')).toBe(true);
    expect(bundleSafeToInline('var a=1;')).toBe(true);
  });
});

describe('GET /api/preview-host/vivliostyle.js', () => {
  it('ビューア bundle を text/javascript・no-store で配る(2 回目はキャッシュから同一内容)', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/preview-host/vivliostyle.js' });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('text/javascript');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body).toContain('window.Vivliostyle=module.exports');
    // 2 回目は `bundleCache` 命中(読取・IIFE ラップをやり直さない)。同一内容で確かめる。
    const b = await app.inject({ method: 'GET', url: '/api/preview-host/vivliostyle.js' });
    expect(b.body).toBe(a.body);
  });
});

describe('GET /api/preview-host/index.html — 内蔵できないバンドルのとき', () => {
  it('バンドルを内蔵せず <script src> でホストページを組み、その参照先は配信ルートで取れる', async () => {
    // ページキャッシュはモジュール内にあるので、モジュールごと読み直して判定だけ差し替える。
    vi.resetModules();
    vi.doMock('../src/util/inlineBundle.js', () => ({ bundleSafeToInline: () => false }));
    try {
      const { previewHostRoutes } = await import('../src/vivliostyle/previewHost.js');
      const fallback = Fastify();
      fallback.decorateRequest('user', undefined);
      fallback.register(previewHostRoutes, { prefix: '/api' });
      await fallback.ready();
      try {
        const page = await fallback.inject({ method: 'GET', url: '/api/preview-host/index.html' });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('<script src="vivliostyle.js"></script>');
        expect(page.body).not.toContain('window.Vivliostyle=');
        // 骨格(boot)は内蔵時と同じ。差し替わるのはバンドルの載せ方だけ。
        expect(page.body).toContain('editor:preview-doc');
        const script = await fallback.inject({
          method: 'GET',
          url: '/api/preview-host/vivliostyle.js',
        });
        expect(script.statusCode).toBe(200);
        expect(script.body).toContain('window.Vivliostyle=module.exports');
      } finally {
        await fallback.close();
      }
    } finally {
      vi.doUnmock('../src/util/inlineBundle.js');
    }
  });
});
