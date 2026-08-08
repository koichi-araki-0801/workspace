// =============================================================================
// renderHost.test.ts — Jinja 隔離レンダーホストの経路専用 CSP・定数性・脱出耐性
// =============================================================================
// 主張は 4 つ。
//   1. ホストページ応答の CSP が**この経路だけ**緩い(全域 CSP は据え置き)。とくに
//      `connect-src 'none'` — 「脱出しても持ち出せない」が本経路の隔離の要である。
//   2. ホストページが利用者入力を 1 バイトも含まない定数であること(テンプレ本文は
//      postMessage で渡す設計の裏返し。ここに入力が混ざると `'unsafe-inline'` が
//      そのまま注入面になる)。
//   3. nunjucks バンドルがページへ**内蔵**されていること(子にネットワーク要求をさせない)。
//   4. 配信面が「ホストページ + バンドル」の 2 本しかなく、迂回入力で 1 バイトも出ないこと。
// さらに、実際に配ったバイト列の中のブートスクリプトを動かし、既知の脱出ペイロード
// (`{{ range.constructor("…")() }}`)が**失敗する**ことまで見る。CSP と内蔵の主張だけだと
// 「多層防御を消しても緑」になるため、脱出そのものの遮断は独立に固定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-render-host-'));
// `config` は import 時に env を読む。データ面は一切使わないが、既定の `editor-data` を
// 掘らせないよう temp へ寄せる(`webDist` は既定のままにする — nunjucks バンドルの
// 解決元がそこだから)。
process.env.DATA_ROOT = tmp;
process.env.AUTH_REQUIRED = 'false';

let app: FastifyInstance;

beforeAll(async () => {
  const { buildCspDirectives } = await import('../src/config.js');
  const { renderHostRoutes } = await import('../src/render/renderHost.js');
  app = Fastify();
  app.decorateRequest('user', undefined);
  // `app.ts` と同じ順序: helmet(全域)→ ルート。経路専用 CSP は onSend で上書きする。
  app.register(helmet, {
    contentSecurityPolicy: { useDefaults: true, directives: buildCspDirectives([]) },
  });
  app.register(renderHostRoutes, { prefix: '/api' });
  // 緩和が漏れていないことの対照。
  app.get('/api/health', async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/render-host/index.html', () => {
  it('経路専用 CSP が nunjucks のコンパイルを許しつつ外向きの面を全部閉じる', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/render-host/index.html' });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    // nunjucks は**コンパイラ**なので `'unsafe-eval'` が要る。これを許せる場所を
    // opaque オリジンのこの子だけに閉じるのが本経路の存在理由。
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    // 全域 CSP(ハッシュのみ)が残っていると子のブートスクリプトが落ちる = 退行。
    expect(/script-src[^;]*sha256-/.test(csp)).toBe(false);
    // 隔離の要。preview-host と違いこの子は外部から何も引かないので、通信面を全部閉じる
    // ことができる。ここが開くと「脱出しても持ち出せない」という主防御が崩れる。
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("style-src 'none'");
    // ナビゲーション型の持ち出し(form submit)と埋め込み元・入れ子 sandbox も塞ぐ。
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // 外部ホストを 1 つも許していない(`connect-src 'none'` の抜け道を作らない)。
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it('緩和はこの経路だけに閉じている(他ルートは全域 CSP のまま)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const csp = res.headers['content-security-policy'] as string;
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false);
  });

  it('ページは定数で、テンプレ本文を 1 バイトも含まない(テンプレは postMessage で渡す)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/render-host/index.html' });
    // nunjucks バンドルはページへ**内蔵**する。opaque オリジンの子のサブリソース要求には
    // SameSite=Lax のセッション cookie が付かず、`<script src>` は認証オン配備で 401 に
    // なる(preview-host での実測)。内蔵ならネットワーク要求自体が無い。
    expect(res.body).toContain('nunjucks 3.2.4');
    expect(res.body).not.toContain('<script src=');
    expect(res.body).toContain('editor:render-req');
    // 定数であることの機械的な言い方: 何度取っても同じバイト列(リクエスト由来の値が
    // 1 つも埋まらない)。クエリで注入できるなら `'unsafe-inline'` がそのまま注入面になる。
    const again = await app.inject({
      method: 'GET',
      url: '/api/render-host/index.html?template={{7*7}}&x=<img src=x onerror=alert(1)>',
    });
    expect(again.body).toBe(res.body);
  });
});

describe('GET /api/render-host/* — 配信面は完全一致 1 件だけ', () => {
  it('fallback 用の nunjucks バンドルは配る', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/render-host/nunjucks.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.body).toContain('nunjucks 3.2.4');
  });

  it('迂回入力は 404 で、本文を 1 バイトも出さない', async () => {
    // preview-host は同梱資産(`css/` `js/` `fonts/`)を配る面を持つが、こちらは表示を
    // しないので配る資産が無い。「許可リストが正しいか」ではなく「面が無いか」を主張する。
    const cases = [
      // 置き場の外(`..` の遡上。素の形と URL エンコード形の両方)
      '/api/render-host/../config.ts',
      '/api/render-host/%2e%2e/%2e%2e/package.json',
      // preview-host では配る面がある置き場。ここでは配ってはならない。
      '/api/render-host/js/app.js',
      '/api/render-host/css/510037.css',
      '/api/render-host/fonts/x.woff2',
      // 完全一致からの逸脱(前方一致・後方一致・大文字化で通らないこと)
      '/api/render-host/nunjucks.js.map',
      '/api/render-host/x/nunjucks.js',
      '/api/render-host/NUNJUCKS.JS',
      // ルート絶対・絶対 URL
      '/api/render-host//etc/passwd',
      '/api/render-host/https://evil.example/x.js',
    ];
    for (const url of cases) {
      const res = await app.inject({ method: 'GET', url });
      expect([404, 400], `${url} → ${res.statusCode}`).toContain(res.statusCode);
      expect(res.body, `${url} が本文を返した`).not.toContain('nunjucks 3.2.4');
    }
  });
});

// ── 実際に配ったバイト列の中で、脱出ペイロードが失敗することの固定 ──
// ページの inline `<script>` を配信順に取り出し、ブラウザに近い最小のグローバル
// (`window` / `self` / `parent` / `addEventListener`)を張った vm で走らせる。子は
// postMessage しか外部インタフェースを持たないので、これで実機に十分近い形になる。
describe('ブートスクリプトの多層防御(nunjucks サンドボックス脱出の遮断)', () => {
  /** ホストページの inline script を配信順に実行し、REQ を送る関数を返す。 */
  async function bootChild(): Promise<
    (req: { id: number; template: string; data?: unknown }) => Record<string, unknown> | undefined
  > {
    const res = await app.inject({ method: 'GET', url: '/api/render-host/index.html' });
    const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    // バンドル + boot の 2 本。1 本しか取れないなら内蔵が壊れている(= 前提が崩れている)。
    expect(scripts.length).toBe(2);

    const posted: Record<string, unknown>[] = [];
    const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
    let listener: ((e: { source: unknown; data: unknown }) => void) | null = null;
    const sandbox: Record<string, unknown> = {
      parent,
      addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
        if (type === 'message') listener = fn;
      },
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    for (const src of scripts) vm.runInContext(src, context);
    // ブートが READY を出していない = nunjucks が載っていない。
    expect(posted.map((m) => m.type)).toContain('editor:render-ready');
    expect(listener).not.toBeNull();

    return (req) => {
      posted.length = 0;
      (listener as unknown as (e: { source: unknown; data: unknown }) => void)({
        source: parent,
        data: { type: 'editor:render-req', ...req },
      });
      return posted[0];
    };
  }

  it('正当なテンプレは今までどおり描画され、自動エスケープも効く', async () => {
    const send = await bootChild();
    const res = send({
      id: 1,
      template: '{{ 名前 }}/{% for i in xs %}{{ i }}{% endfor %}',
      data: { 名前: '<b>', xs: [1, 2, 3] },
    });
    expect(res).toEqual({ type: 'editor:render-res', id: 1, html: '&lt;b&gt;/123' });
  });

  it('グローバル経由の脱出ペイロードが実行されない', async () => {
    const send = await bootChild();
    // 元の攻撃文字列そのもの。nunjucks 3.2.4 では `range` グローバル → `constructor`
    // (= Function)→ 呼び出しで任意 JS に到達し、承認者のセッションで承認 API を叩けた。
    // ここでは `escaped` が立たないこと = 評価されないことを主張する。
    (globalThis as Record<string, unknown>).__renderHostEscaped = false;
    const res = send({
      id: 7,
      template: '{{ range.constructor("globalThis.__renderHostEscaped=true")() }}',
      data: {},
    });
    expect((globalThis as Record<string, unknown>).__renderHostEscaped).toBe(false);
    expect(res?.type).toBe('editor:render-error');
    expect(res?.id).toBe(7);
  });

  it('プロパティ経由の迂回(動的キー・リテラル・__proto__)も通らない', async () => {
    const send = await bootChild();
    (globalThis as Record<string, unknown>).__renderHostEscaped = false;
    const payloads = [
      // `globals` を空にしただけだと素通りする形: 文字列リテラルから Function を取る。
      '{{ "".constructor.constructor("globalThis.__renderHostEscaped=true")() }}',
      // 配列リテラル経由。上と同じく `memberLookup` を通る。
      '{{ [].constructor.constructor("globalThis.__renderHostEscaped=true")() }}',
      // 名前を文字列変数に逃がす動的キー。名前の**完全一致**判定を `memberLookup` の
      // 中でやっている以上、静的・動的のどちらでも同じ関門を通る。
      '{% set k = "constructor" %}{{ ({})[k][k]("globalThis.__renderHostEscaped=true")() }}',
      // `Context.lookup` は `name in env.globals` で引くため、globals が素の `{}` だと
      // Object.prototype 由来の `constructor` がグローバルとして見えてしまう。
      '{{ constructor.constructor("globalThis.__renderHostEscaped=true")() }}',
      // プロトタイプ経由(汚染 + そこからの関数取得)。
      '{{ ({}).__proto__.constructor("globalThis.__renderHostEscaped=true")() }}',
    ];
    for (const template of payloads) {
      const res = send({ id: 1, template, data: {} });
      expect(
        (globalThis as Record<string, unknown>).__renderHostEscaped,
        `脱出した: ${template}`,
      ).toBe(false);
      // 出力にも中身を漏らさない(例外か空文字のどちらかで、コードは 1 度も走らない)。
      if (res?.type === 'editor:render-res') expect(res.html).not.toContain('function');
    }
  });

  // ── nunjucks が外部の値へ触る経路(この列挙が防御の単位) ──
  // 防御は「プロパティ参照」「グローバル参照」「フィルタ解決」の 3 経路を塞ぐ形で書かれて
  // いる。フィルタ解決は前 2 者の関門を通らないため、独立に閉じる必要がある。
  // 経路が増えた/包み忘れたことをここで検出する。
  it('フィルタ解決から Object.prototype 由来の値を引けない', async () => {
    const send = await bootChild();
    (globalThis as Record<string, unknown>).__renderHostEscaped = false;
    // `1|valueOf` は `Object.prototype.valueOf.call(context, 1)` として解決されると
    // **Context そのもの**を返す。そこから `env` → `getFilter("constructor")`(= Object)
    // → `Function` と辿れてしまうのが F2 の経路。起点のフィルタ解決を閉じたので落ちる。
    const res = send({ id: 21, template: '{{ 1|valueOf }}', data: {} });
    expect(res?.type).toBe('editor:render-error');

    // 完全な脱出連鎖。`"constructor"` は**文字列引数**なので名前遮断には掛からない —
    // だからこそ起点(フィルタ解決)を閉じる必要がある。
    const chain =
      '{% set c = 1|valueOf %}{% set O = c.env.getFilter("constructor") %}' +
      '{% set F = O.getOwnPropertyDescriptor(O.getPrototypeOf(O), "constructor").value %}' +
      '{{ F("globalThis.__renderHostEscaped=true")() }}';
    send({ id: 22, template: chain, data: {} });
    expect((globalThis as Record<string, unknown>).__renderHostEscaped).toBe(false);

    // 継承経由で引ける他の名前も同様に「未知のフィルタ」で落ちる。
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__defineGetter__']) {
      expect(send({ id: 23, template: `{{ 1|${name} }}`, data: {} })?.type).toBe(
        'editor:render-error',
      );
    }
  });

  it('組み込みフィルタは今までどおり使える(防御が正常系を壊していない)', async () => {
    const send = await bootChild();
    const res = send({
      id: 24,
      template: '{{ "a,b"|replace(",", " / ") }}|{{ [3,1,2]|sort|join("-") }}|{{ "x"|upper }}',
      data: {},
    });
    expect(res).toEqual({ type: 'editor:render-res', id: 24, html: 'a / b|1-2-3|X' });
  });

  it('親以外からのメッセージは無視する(発信元の同一性で弾く)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/render-host/index.html' });
    const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const posted: Record<string, unknown>[] = [];
    const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
    let listener: ((e: { source: unknown; data: unknown }) => void) | null = null;
    const sandbox: Record<string, unknown> = {
      parent,
      addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
        if (type === 'message') listener = fn;
      },
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    for (const src of scripts) vm.runInContext(src, vm.createContext(sandbox));
    posted.length = 0;
    // 別の window(例: 同居する他の sandbox フレーム)を騙る。子 → 親の `event.origin` は
    // どの opaque フレームでも `'null'` なので、判定は source の同一性でしか行えない。
    (listener as unknown as (e: { source: unknown; data: unknown }) => void)({
      source: { fake: true },
      data: { type: 'editor:render-req', id: 1, template: '{{ 1 }}', data: {} },
    });
    expect(posted).toEqual([]);
  });
});
