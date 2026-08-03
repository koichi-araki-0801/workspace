// =============================================================================
// config.security.test.ts — 危険な既定値の禁止・CSP・認証前バッファ上限の単体テスト
// =============================================================================
// `config.ts` の security 節(`isLoopbackHost` / `assertAuthRequiredWhenExposed` /
// `isBufferedUploadContentType` / CSP ビルダ)と、起動時アサーションが import 時点で
// 効くことを固定する。env を差し替えて評価し直すため、モジュールは毎回 `vi.resetModules()`
// してから動的 import する(`config.ts` は import 時に env を読んで値を確定する)。
import crypto from 'node:crypto';
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

// --- 危険な既定値の禁止(F36) ------------------------------------------------

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

describe('assertAuthRequiredWhenExposed', () => {
  it('rejects an exposed bind while authentication is off', async () => {
    const { assertAuthRequiredWhenExposed } = await importConfig();
    expect(() => assertAuthRequiredWhenExposed('0.0.0.0', false)).toThrow(/AUTH_REQUIRED=true/);
    expect(() => assertAuthRequiredWhenExposed('192.168.0.9', false)).toThrow(/loopback/);
  });

  it('allows an exposed bind with authentication, and loopback either way', async () => {
    const { assertAuthRequiredWhenExposed } = await importConfig();
    expect(() => assertAuthRequiredWhenExposed('0.0.0.0', true)).not.toThrow();
    expect(() => assertAuthRequiredWhenExposed('127.0.0.1', false)).not.toThrow();
  });
});

describe('startup assertion (config module evaluation)', () => {
  it('refuses to load with HOST=0.0.0.0 and no AUTH_REQUIRED', async () => {
    await expect(
      importConfigWithEnv({ HOST: '0.0.0.0', AUTH_REQUIRED: undefined }),
    ).rejects.toThrow(/AUTH_REQUIRED=true/);
  });

  it('loads with HOST=0.0.0.0 when AUTH_REQUIRED=true', async () => {
    const mod = await importConfigWithEnv({ HOST: '0.0.0.0', AUTH_REQUIRED: 'true' });
    expect(mod.config.host).toBe('0.0.0.0');
    expect(mod.config.requireAuth).toBe(true);
  });

  it('keeps the loopback default (no HOST) loading without authentication', async () => {
    const mod = await importConfigWithEnv({ HOST: undefined, AUTH_REQUIRED: undefined });
    expect(mod.config.host).toBe('127.0.0.1');
    expect(mod.config.requireAuth).toBe(false);
  });
});

// --- 認証前バッファ(F32) ----------------------------------------------------

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

// content-type だけを見ていた頃は、`application/json` へ変えるだけで `POST /api/build/merge` の
// 32MB を未認証で積めた(ルート単位の `bodyLimit` 引き上げは preHandler より先に効く)。
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
});

describe('upload size limits', () => {
  it('falls back to the default when the env value is not a positive number', async () => {
    const bad = await importConfigWithEnv({ VIVLIO_MAX_PROJECT_BYTES: '64MB' });
    expect(bad.config.vivliostyle.build.maxProjectBytes).toBe(64 * 1024 * 1024);

    const zero = await importConfigWithEnv({ VIVLIO_MAX_PROJECT_BYTES: '0' });
    expect(zero.config.vivliostyle.build.maxProjectBytes).toBe(64 * 1024 * 1024);
  });

  it('honours a valid override', async () => {
    const mod = await importConfigWithEnv({ VIVLIO_MAX_PROJECT_BYTES: '1024' });
    expect(mod.config.vivliostyle.build.maxProjectBytes).toBe(1024);
  });
});

// --- CSP(F34) ---------------------------------------------------------------

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
    // nunjucks がテンプレートを実行時コンパイルするため eval は必須、inline は禁止のまま。
    expect(d.scriptSrc).toContain("'unsafe-eval'");
    expect(d.scriptSrc).toContain("'sha256-abc'");
    expect(d.scriptSrc).not.toContain("'unsafe-inline'");
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
    expect(csp).toContain("script-src 'self' 'unsafe-eval'");
    expect(csp).toContain('frame-src');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});
