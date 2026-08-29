// =============================================================================
// config.security.test.ts — 危険な既定値の禁止・CSP・認証前バッファ上限の単体テスト
// =============================================================================
// `config.ts` の security 節(`isLoopbackHost` / `assertSafeExposure` / env parse /
// `isBufferedUploadContentType` / CSP ビルダ)と、起動時アサーションが import 時点で
// 効くことを固定する。env を差し替えて評価し直すため、モジュールは毎回 `vi.resetModules()`
// してから動的 import する(`config.ts` は import 時に env を読んで値を確定する)。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

type ConfigModule = typeof import('../src/config.js');

/** env を一時的に差し替えて `config.ts` を評価し直す(評価後に env は元へ戻す)。 */
async function importConfigWithEnv(env: Record<string, string | undefined>): Promise<ConfigModule> {
  const saved = new Map(Object.entries(env).map(([k]) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await import('../src/config.js');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const importConfig = () => importConfigWithEnv({});

// --- 危険な既定値の禁止 ------------------------------------------------------

describe('isLoopbackHost', () => {
  it('treats loopback spellings as same-machine only', async () => {
    const { isLoopbackHost } = await importConfig();
    for (const host of ['127.0.0.1', ' 127.0.0.53 ', 'localhost', 'LocalHost', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('treats all-interfaces binds and concrete LAN addresses as exposed', async () => {
    const { isLoopbackHost } = await importConfig();
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.10.5', '10.0.0.1', '']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('assertSafeExposure', () => {
  /** 既定は「loopback bind・認証あり・TLS あり・Secure cookie」の安全側。 */
  const safe = {
    host: '127.0.0.1',
    previewHost: '127.0.0.1',
    requireAuth: true,
    tlsEnabled: true,
    cookieSecure: true,
    allowPlaintext: false,
  };

  it('rejects an exposed bind while authentication is off', async () => {
    const { assertSafeExposure } = await importConfig();
    expect(() => assertSafeExposure({ ...safe, host: '0.0.0.0', requireAuth: false })).toThrow(
      /AUTH_REQUIRED=true/,
    );
    expect(() => assertSafeExposure({ ...safe, host: '192.168.0.9', requireAuth: false })).toThrow(
      /loopback/,
    );
  });

  // requireAuth が真なら早期 return して TLS の有無を見ない判定は、同一 LAN から
  // ログイン資格情報が平文で読める構成を通してしまう。認証と TLS は独立に検査する。
  it('rejects an exposed bind without TLS even when authentication is on', async () => {
    const { assertSafeExposure } = await importConfig();
    expect(() => assertSafeExposure({ ...safe, host: '0.0.0.0', tlsEnabled: false })).toThrow(
      /TLS が無効/,
    );
    expect(() =>
      assertSafeExposure({ ...safe, host: '0.0.0.0', tlsEnabled: false, allowPlaintext: true }),
    ).not.toThrow();
  });

  // preview listener は Fastify の preHandler の外側で、認証を掛ける手段が無い。
  // 免除(opt-in)を設けないのが要点 — 用意すれば必ず誤用される。
  it('rejects a non-loopback preview host unconditionally', async () => {
    const { assertSafeExposure } = await importConfig();
    for (const previewHost of ['0.0.0.0', '::', '192.168.0.9']) {
      expect(() => assertSafeExposure({ ...safe, previewHost }), previewHost).toThrow(
        /VIVLIO_PREVIEW_HOST/,
      );
    }
    for (const previewHost of ['127.0.0.1', 'localhost', '::1']) {
      expect(() => assertSafeExposure({ ...safe, previewHost }), previewHost).not.toThrow();
    }
  });

  it('rejects TLS with the Secure cookie flag explicitly turned off (contradiction)', async () => {
    const { assertSafeExposure } = await importConfig();
    expect(() =>
      assertSafeExposure({ ...safe, cookieSecure: false, cookieSecureExplicit: false }),
    ).toThrow(/COOKIE_SECURE/);
    // 逆向き(前段プロキシで TLS 終端 + loopback 平文 + Secure)は正当なので通す。
    expect(() =>
      assertSafeExposure({ ...safe, tlsEnabled: false, cookieSecure: true }),
    ).not.toThrow();
  });

  // `HTTPS=true` は dev でも使える明示 opt-in。利用者が COOKIE_SECURE を一度も書いて
  // いないのに「同時に指定できません」で起動を止めるのは、指定していない変数を原因として
  // 名指しすることになる。既定値由来の false では止めない。
  it('allows HTTPS=true when COOKIE_SECURE was never specified', async () => {
    const { assertSafeExposure } = await importConfig();
    expect(() =>
      assertSafeExposure({ ...safe, cookieSecure: false, cookieSecureExplicit: undefined }),
    ).not.toThrow();
  });

  it('allows an exposed bind with authentication and TLS, and loopback either way', async () => {
    const { assertSafeExposure } = await importConfig();
    expect(() => assertSafeExposure({ ...safe, host: '0.0.0.0' })).not.toThrow();
    expect(() =>
      assertSafeExposure({ ...safe, requireAuth: false, tlsEnabled: false, cookieSecure: false }),
    ).not.toThrow();
  });
});

// `=== 'true'` 以外をすべて false へ倒す真偽値解釈だと、`AUTH_REQUIRED=1` と
// 書いた運用者は認証が無効のまま起動してしまう。未知の値は既定へ倒さず起動を中止する。
describe('真偽値 env の許可トークン集合', () => {
  it('accepts every documented true spelling for AUTH_REQUIRED', async () => {
    for (const raw of ['1', 'true', 'TRUE', ' true ', 'yes', 'on']) {
      const mod = await importConfigWithEnv({ AUTH_REQUIRED: raw });
      expect(mod.config.requireAuth, raw).toBe(true);
    }
  });

  it('accepts every documented false spelling', async () => {
    for (const raw of ['0', 'false', 'no', 'OFF']) {
      const mod = await importConfigWithEnv({ AUTH_REQUIRED: raw });
      expect(mod.config.requireAuth, raw).toBe(false);
    }
  });

  it('refuses to start on an unknown spelling, naming the variable', async () => {
    for (const raw of ['ture', 'enabled', '"true"', '']) {
      await expect(importConfigWithEnv({ AUTH_REQUIRED: raw }), raw).rejects.toThrow(
        /AUTH_REQUIRED/,
      );
    }
  });

  it('applies the same rule to the other boolean switches', async () => {
    await expect(importConfigWithEnv({ AUDIT_DB: 'ON!' })).rejects.toThrow(/AUDIT_DB/);
    await expect(importConfigWithEnv({ LOG_PRETTY: 'maybe' })).rejects.toThrow(/LOG_PRETTY/);
    await expect(importConfigWithEnv({ COOKIE_SECURE: 'ture' })).rejects.toThrow(/COOKIE_SECURE/);
  });

  // HTTPS=1 は「TLS 有効」— `=== 'true'` だけの解釈はこれを false にして平文で起動してしまう。
  it('turns TLS on for HTTPS=1 (the old parser silently served plaintext)', async () => {
    const mod = await importConfigWithEnv({ HTTPS: '1', COOKIE_SECURE: 'true' });
    expect(mod.config.tls.enabled).toBe(true);
  });
});

// 資源上限が素の `Number()` のままだと `'three'` が NaN になり、
// `size >= NaN` が常に false = 上限が黙って消える。
describe('数値 env の形式検証', () => {
  it('never lets a resource limit become NaN', async () => {
    for (const raw of ['three', '0', '-1', '0x10', '1e9', '4.5']) {
      await expect(importConfigWithEnv({ VIVLIO_PREVIEW_MAX: raw }), raw).rejects.toThrow(
        /VIVLIO_PREVIEW_MAX/,
      );
    }
    const ok = await importConfigWithEnv({ VIVLIO_PREVIEW_MAX: '8' });
    expect(Number.isInteger(ok.config.vivliostyle.preview.maxSessions)).toBe(true);
    expect(ok.config.vivliostyle.preview.maxSessions).toBe(8);
  });

  it('guards the auth TTL, the port and the DB pool the same way', async () => {
    await expect(importConfigWithEnv({ AUTH_SESSION_TTL_HOURS: '12h' })).rejects.toThrow(
      /AUTH_SESSION_TTL_HOURS/,
    );
    await expect(importConfigWithEnv({ PORT: '0' })).rejects.toThrow(/PORT/);
    await expect(importConfigWithEnv({ PORT: '70000' })).rejects.toThrow(/PORT/);
    await expect(importConfigWithEnv({ DB_POOL_MAX: '-4' })).rejects.toThrow(/DB_POOL_MAX/);
  });

  it('keeps VIVLIO_BUILD_POOL=0 working (the documented per-job spawn fallback)', async () => {
    const mod = await importConfigWithEnv({ VIVLIO_BUILD_POOL: '0' });
    expect(mod.config.vivliostyle.build.poolSize).toBe(0);
  });
});

describe('startup assertion (config module evaluation)', () => {
  it('refuses to load with HOST=0.0.0.0 and no AUTH_REQUIRED', async () => {
    await expect(
      importConfigWithEnv({ HOST: '0.0.0.0', AUTH_REQUIRED: undefined }),
    ).rejects.toThrow(/AUTH_REQUIRED=true/);
  });

  // TLS 必須化により、認証だけでは足りない。証明書か明示の平文 opt-in が要る。
  it('refuses to load with HOST=0.0.0.0 and AUTH_REQUIRED but no TLS', async () => {
    await expect(
      importConfigWithEnv({ HOST: '0.0.0.0', AUTH_REQUIRED: 'true', HTTPS: undefined }),
    ).rejects.toThrow(/TLS が無効/);
  });

  it('loads with HOST=0.0.0.0 when AUTH_REQUIRED and HTTPS are both on', async () => {
    const mod = await importConfigWithEnv({
      HOST: '0.0.0.0',
      AUTH_REQUIRED: 'true',
      HTTPS: 'true',
      COOKIE_SECURE: 'true',
    });
    expect(mod.config.host).toBe('0.0.0.0');
    expect(mod.config.requireAuth).toBe(true);
    expect(mod.config.tls.enabled).toBe(true);
  });

  it('loads plaintext LAN only with the explicit opt-in', async () => {
    const mod = await importConfigWithEnv({
      HOST: '0.0.0.0',
      AUTH_REQUIRED: 'true',
      ALLOW_PLAINTEXT_LAN: '1',
      COOKIE_SECURE: 'false',
    });
    expect(mod.allowPlaintextLan).toBe(true);
  });

  // 起動時経路: HOST が既定 loopback のままでも、preview listener だけの公開は許さない。
  it('refuses to load when VIVLIO_PREVIEW_HOST is exposed', async () => {
    await expect(importConfigWithEnv({ VIVLIO_PREVIEW_HOST: '0.0.0.0' })).rejects.toThrow(
      /VIVLIO_PREVIEW_HOST/,
    );
  });

  it('keeps the loopback default (no HOST) loading without authentication', async () => {
    const mod = await importConfigWithEnv({ HOST: undefined, AUTH_REQUIRED: undefined });
    expect(mod.config.host).toBe('127.0.0.1');
    expect(mod.config.requireAuth).toBe(false);
  });
});

// --- 認証前バッファ -----------------------------------------------------------

describe('isBufferedUploadContentType', () => {
  it('matches the zip/octet-stream parser regardless of parameters and case', async () => {
    const { isBufferedUploadContentType } = await importConfig();
    expect(isBufferedUploadContentType('application/zip')).toBe(true);
    expect(isBufferedUploadContentType(' APPLICATION/ZIP ')).toBe(true);
    expect(isBufferedUploadContentType('application/octet-stream; charset=binary')).toBe(true);
  });

  it('leaves other request bodies (JSON, multipart) alone', async () => {
    const { isBufferedUploadContentType } = await importConfig();
    expect(isBufferedUploadContentType('application/json')).toBe(false);
    expect(isBufferedUploadContentType('multipart/form-data; boundary=x')).toBe(false);
    expect(isBufferedUploadContentType(undefined)).toBe(false);
  });
});

// content-type だけを見る判定では、`application/json` へ変えるだけで `POST /api/build/merge` の
// 32MB を未認証で積める(ルート単位の `bodyLimit` 引き上げは preHandler より先に効く)。
describe('isPreAuthBufferedRequest', () => {
  it('gates the zip parser and the routes that raise the body limit', async () => {
    const { isPreAuthBufferedRequest } = await importConfig();
    // zip はどの path でも(content-type で判定)。
    expect(isPreAuthBufferedRequest('POST', '/api/anything', 'application/zip')).toBe(true);
    for (const url of ['/api/build/merge', '/api/build/project', '/api/preview']) {
      expect(isPreAuthBufferedRequest('POST', url, 'application/json'), url).toBe(true);
    }
    // query が付いても path で判定する。
    expect(isPreAuthBufferedRequest('POST', '/api/preview?entry=a.html', 'application/json')).toBe(
      true,
    );
  });

  it('leaves ordinary requests to the preHandler chain', async () => {
    const { isPreAuthBufferedRequest } = await importConfig();
    // グローバル bodyLimit(8MB)で足りるルートは対象外(無駄なセッション解決を増やさない)。
    expect(isPreAuthBufferedRequest('POST', '/api/build', 'application/json')).toBe(false);
    expect(isPreAuthBufferedRequest('POST', '/api/auth/login', 'application/json')).toBe(false);
    // 本文を持たないメソッドは積みようがない。
    expect(isPreAuthBufferedRequest('GET', '/api/preview', undefined)).toBe(false);
    expect(isPreAuthBufferedRequest(undefined, undefined, undefined)).toBe(false);
  });

  // ── 生の request target を渡してはならない ──
  // find-my-way は percent-encoding を解いてから照合するのに、この関数は解かない。
  // よって**生 target を渡すと素通りする**。渡すべきは `request.routeOptions.url`。
  it('生の request target(percent-encoded / absolute-form)は照合に当たらない', async () => {
    const { isPreAuthBufferedRequest } = await importConfig();
    for (const raw of [
      '/api/build/%6Derge',
      '/api/build/%70roject',
      'http://127.0.0.1:24680/api/build/merge',
      '/api/./build/merge',
    ]) {
      expect(isPreAuthBufferedRequest('POST', raw, 'application/json'), raw).toBe(false);
    }
  });
});

// ゲートが**実際にルーティングされたパターン**で判定していることを、Fastify を通して主張する。
// URL の選択は `app.ts` が使うのと同じ `preAuthGateUrl` を呼ぶ(式を写すと、呼び出し側だけの
// 退行を検出できない)。生 target で照合すると `POST /api/build/%6Derge` がここを外し、
// 未認証のままルートの `bodyLimit`(32MB)いっぱいを積める。
describe('onRequest ゲートはルーティング結果で照合する', () => {
  /** merge ルートを `/api` prefix つきで持つ最小構成。ゲート発火を配列へ記録する。 */
  async function buildProbe(): Promise<{
    app: ReturnType<typeof Fastify>;
    gated: string[];
  }> {
    const { isPreAuthBufferedRequest, preAuthGateUrl } = await importConfig();
    const gated: string[] = [];
    const app = Fastify();
    app.register(
      async (scope) => {
        scope.post('/build/merge', { bodyLimit: 32 * 1024 * 1024 }, async () => ({ ok: true }));
      },
      { prefix: '/api' },
    );
    app.addHook('onRequest', async (request) => {
      const gateUrl = preAuthGateUrl(request);
      if (isPreAuthBufferedRequest(request.method, gateUrl, request.headers['content-type'])) {
        gated.push(request.url);
      }
    });
    await app.ready();
    return { app, gated };
  }

  it.each([
    ['そのまま', '/api/build/merge'],
    ['percent-encoded', '/api/build/%6Derge'],
    ['dot セグメント', '/api/./build/merge'],
    ['absolute-form', 'http://127.0.0.1:24680/api/build/merge'],
  ])('%s の request target でもゲートが発火する', async (_label, url) => {
    const { app, gated } = await buildProbe();
    try {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      // どの綴りでも同じハンドラへ届く = 32MB の bodyLimit が当たる経路である。
      expect(res.statusCode).toBe(200);
      expect(gated).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // 上の probe は本番の hook そのものではないので、配線もソース走査で固定する。
  // `request.url`(生 target)を直接渡す形へ戻したら落ちる。
  it('app.ts の onRequest は preAuthGateUrl を通す(生 target を渡さない)', async () => {
    const src = await fs.readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
    const call = /isPreAuthBufferedRequest\(\s*request\.method,\s*([^,]+),/.exec(src);
    expect(call?.[1]?.trim()).toBe('gateUrl');
    expect(src).toContain('const gateUrl = preAuthGateUrl(request);');
  });

  it('ルートに当たらないリクエストはゲートしない(無駄なセッション解決を増やさない)', async () => {
    const { app, gated } = await buildProbe();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/build/merge-x',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(404);
      expect(gated).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('upload size limits', () => {
  // 仕様変更(旧: 既定へ倒す)。既定へ倒すと `'64MB'` と書いた運用者は上限が変わって
  // いないことに一生気付けない — 上書きしたつもりの無防備が残るので fail-fast にする。
  it('refuses to start when the env value is not a positive decimal number', async () => {
    await expect(importConfigWithEnv({ VIVLIO_MAX_PROJECT_BYTES: '64MB' })).rejects.toThrow(
      /VIVLIO_MAX_PROJECT_BYTES/,
    );
    await expect(importConfigWithEnv({ VIVLIO_MAX_PROJECT_BYTES: '0' })).rejects.toThrow(
      /VIVLIO_MAX_PROJECT_BYTES/,
    );
  });

  it('honours a valid override', async () => {
    const mod = await importConfigWithEnv({ VIVLIO_MAX_PROJECT_BYTES: '1024' });
    expect(mod.config.vivliostyle.build.maxProjectBytes).toBe(1024);
  });
});

// 存在オラクル対策(失敗応答の時間フロア)のパラメータも `envNumber` の規律の内側に置く。
// 素の `Number()` だと `AUTH_FAILURE_FLOOR_MS=`(空)が 0 になって**防御が無言で消え**、
// `1e9` が受理されて全失敗応答が 11 日待ちになる。
describe('認証失敗の時間フロア', () => {
  it.each([
    '',
    ' ',
    '1e9',
    'abc',
    '-1',
    '10001',
  ])('refuses to start when AUTH_FAILURE_FLOOR_MS=%j', async (value) => {
    await expect(importConfigWithEnv({ AUTH_FAILURE_FLOOR_MS: value })).rejects.toThrow(
      /AUTH_FAILURE_FLOOR_MS/,
    );
  });

  it('未指定なら 300ms、明示指定はそのまま効く', async () => {
    expect((await importConfigWithEnv({})).config.auth.failedAuthFloorMs).toBe(300);
    const mod = await importConfigWithEnv({ AUTH_FAILURE_FLOOR_MS: '0' });
    expect(mod.config.auth.failedAuthFloorMs).toBe(0);
  });
});

// --- CSP ----------------------------------------------------------------------

describe('inlineScriptCspHashes', () => {
  it('hashes each inline script body and skips external/empty ones', async () => {
    const { inlineScriptCspHashes } = await importConfig();
    const body = "document.documentElement.setAttribute('data-theme','dark');";
    const html =
      `<html><head><script>${body}</script>` +
      '<script type="module" src="/assets/main.js"></script>' +
      '<script></script></head></html>';

    const expected = `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    expect(inlineScriptCspHashes(html)).toEqual([expected]);
  });

  it('normalizes CRLF so the hash matches what the HTML parser hashes', async () => {
    const { inlineScriptCspHashes } = await importConfig();
    const lf = '<script>\nlet t = 1;\n</script>';

    expect(inlineScriptCspHashes(lf.replace(/\n/g, '\r\n'))).toEqual(inlineScriptCspHashes(lf));
  });

  it('returns nothing for a dev boot without a built SPA (empty html)', async () => {
    const { inlineScriptCspHashes } = await importConfig();
    expect(inlineScriptCspHashes('')).toEqual([]);
  });
});

describe('buildCspDirectives', () => {
  it('allows what the SPA needs without opening inline scripts', async () => {
    const { buildCspDirectives } = await importConfig();
    const d = buildCspDirectives(["'sha256-abc'"]);

    expect(d.scriptSrc).toContain("'self'");
    expect(d.scriptSrc).toContain("'sha256-abc'");
    expect(d.scriptSrc).not.toContain("'unsafe-inline'");
    // アプリオリジンには eval 系の実行手段を残さない。最後の利用者だった
    // `web/src/lib/fillJinja.ts` の値差込は `jinjaExpr.ts` の許可リスト評価器へ移した
    // ため、`new Function` へ届く経路はアプリオリジンに無い(Jinja のコンパイルは
    // opaque オリジンのレンダーホストの中だけ)。戻すと SSTI の受け皿が復活する。
    expect(d.scriptSrc).not.toContain("'unsafe-eval'");
    // プレビューの Blob URL(iframe / 画像 / PDF)。
    expect(d.frameSrc).toContain('blob:');
    expect(d.imgSrc).toContain('blob:');
    expect(d.workerSrc).toContain('blob:');
    // 平文 HTTP の LAN 公開を壊さないため https 強制の既定は外す。
    expect(d.upgradeInsecureRequests).toBeNull();
  });

  it('is accepted by helmet and lands on the response header', async () => {
    const { buildCspDirectives } = await importConfig();
    const app = Fastify();
    await app.register(helmet, {
      contentSecurityPolicy: { useDefaults: true, directives: buildCspDirectives([]) },
    });
    app.get('/', async () => 'ok');

    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'] as string;
    await app.close();

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain('frame-src');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});

// ── Host ヘッダの許可集合(DNS リバインディングの壁) ──
// 攻撃者ページは自分のドメインの DNS を後から 127.0.0.1 へ向け替えられる。ブラウザは
// 同一オリジンだと考えたまま要求を出すので SameSite も CORS も効かず、唯一食い違うのが
// `Host`。効きどころは認証を課さない配備(既定の local モード)で、そこでは実質
// 「loopback に到達できること」だけが認可条件になっている。
describe('resolveAllowedHosts / isAllowedHost', () => {
  const LAN = { hostname: 'desk-01', addresses: ['192.168.1.10', 'fe80::1'] };

  it('loopback bind では loopback 名しか許さない(この機械の LAN 名は入れない)', async () => {
    const { resolveAllowedHosts } = await import('../src/config.js');
    const allowed = resolveAllowedHosts({ host: '127.0.0.1', ...LAN });
    expect([...allowed].sort()).toEqual(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  });

  it('LAN 公開では「この機械が実際に持つ名前とアドレス」だけを足す', async () => {
    const { resolveAllowedHosts } = await import('../src/config.js');
    const allowed = resolveAllowedHosts({ host: '0.0.0.0', ...LAN });
    expect(allowed.has('desk-01')).toBe(true);
    expect(allowed.has('192.168.1.10')).toBe(true);
    // bind の指定であって名乗る名前ではないものは足さない。
    expect(allowed.has('0.0.0.0')).toBe(false);
    // 攻撃者ドメインは当然入らない。
    expect(allowed.has('attacker.example')).toBe(false);
  });

  it('ALLOWED_HOSTS で明示的に足せる(リバースプロキシ経由など)', async () => {
    const { resolveAllowedHosts } = await import('../src/config.js');
    const allowed = resolveAllowedHosts({
      host: '127.0.0.1',
      extra: 'editor.example, EDITOR2.example ',
      ...LAN,
    });
    expect(allowed.has('editor.example')).toBe(true);
    expect(allowed.has('editor2.example')).toBe(true);
  });

  it('判定はホスト名だけで、ポートの有無・IPv6 リテラル・大小文字を吸収する', async () => {
    const { isAllowedHost } = await import('../src/config.js');
    const allowed = new Set(['localhost', '127.0.0.1', '::1', 'desk-01']);
    for (const ok of [
      'localhost',
      'localhost:24680',
      'LocalHost:24680',
      '127.0.0.1:24680',
      '[::1]:24680',
      'desk-01:24680',
    ])
      expect(isAllowedHost(ok, allowed), ok).toBe(true);
    for (const ng of [
      'attacker.example',
      'attacker.example:24680',
      'localhost.attacker.example',
      'attackerlocalhost',
      '',
      undefined,
      // 重複ヘッダは配列で届く。前段との食い違いを作れるので落とす。
      ['localhost', 'attacker.example'],
    ])
      expect(isAllowedHost(ng as string | undefined, allowed), String(ng)).toBe(false);
  });
});
