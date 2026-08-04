// =============================================================================
// routeGuards.test.ts — 変更系ルートのロール強制(viewer 封じ込め)の網羅テスト
// =============================================================================
// `viewer` は閲覧のみのロールだが、以前は台帳の上にしか存在せず、下書きの上書き・削除、
// メモ書き、履歴追記、承認申請の投入まで全部通れた。ここで主張するのは
//   1. 全ルートが `ROUTE_POLICY` に載っていること(表に無いルートを足したら落ちる)
//   2. 表に載っているのに登録されていない行が無いこと(dead entry)
//   3. **表を書き換えただけでガードを付け忘れたら落ちる**こと(実挙動での突き合わせ)
// の 3 点。1 と 3 の両方が要る — 表だけ合っていてもガードが無ければ穴は開いたままで、
// ガードだけ付いていても表が無ければ次のルートで忘れる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UserRole } from '@editor/shared';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-route-guards-'));
process.env.DATA_ROOT = tmp;
process.env.AUTH_REQUIRED = 'true';
process.env.AUTH_FAILURE_FLOOR_MS = '0';

// セッションは cookie `editor.sid=<role>` を「そのロールのユーザ」とみなす最小の偽装。
// 実 DB へは降りないので、ここで観測できるのは preHandler の判定だけになる。
vi.mock('../src/auth/session.js', () => ({
  cookieOptions: {},
  createSession: vi.fn(async () => 'sid'),
  destroySession: vi.fn(async () => {}),
  invalidateAllSessions: vi.fn(async () => {}),
  purgeExpiredSessions: vi.fn(async () => {}),
  sessionIdFrom: (cookie?: string) => cookie?.match(/editor\.sid=([^;]+)/)?.[1],
  getSessionUser: async (sid: string) =>
    sid
      ? {
          id: sid,
          username: sid,
          displayName: sid,
          role: sid,
          disabled: false,
          mustChangePassword: false,
        }
      : null,
}));

// ルートの本体には降りない(降りると DB/python/vivliostyle を叩く)。ガードを通過したか
// だけを見たいので、リポジトリ層は全部モックして「到達したら 500 でなく素直に返る」形にする。
vi.mock('../src/db/sproc.js', () => ({
  callSproc: vi.fn(async () => []),
  firstRow: () => undefined,
  rows: () => [],
  p: (name: string, value: unknown) => ({ name, value }),
  asBool: () => false,
  asBuffer: () => Buffer.alloc(0),
  asNumberOrNull: () => null,
  asString: () => '',
}));

const REGISTERED: RouteOptions[] = [];

let app: FastifyInstance;
let ROUTE_POLICY: Readonly<Record<string, string>>;
let VIEWER_ALLOWED_MUTATIONS: Readonly<Record<string, string>>;

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const guards = await import('../src/routes/routeGuards.js');
  ROUTE_POLICY = guards.ROUTE_POLICY;
  VIEWER_ALLOWED_MUTATIONS = guards.VIEWER_ALLOWED_MUTATIONS;

  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { apiPaths } = await import('@editor/shared');
  app = Fastify();
  app.decorateRequest('user', undefined);
  app.setErrorHandler(errorHandler);
  // 本番(`app.ts`)と同じく register より前に張る。ここで throw すれば起動が落ちる。
  app.addHook('onRoute', (routeOptions) => {
    guards.assertRoutePolicy(routeOptions);
    REGISTERED.push(routeOptions);
  });
  await app.register((await import('@fastify/cookie')).default);
  app.get(`/api${apiPaths.health}`, async () => ({ ok: true }));
  for (const mod of [
    '../src/openapi/index.js',
    '../src/routes/auth.routes.js',
    '../src/routes/vivliostyle.routes.js',
    '../src/routes/templates.routes.js',
    '../src/routes/generate.routes.js',
    '../src/routes/parts.routes.js',
    '../src/routes/reviews.routes.js',
    '../src/routes/history.routes.js',
    '../src/routes/notes.routes.js',
    '../src/routes/users.routes.js',
  ]) {
    const loaded = (await import(mod)) as Record<string, unknown>;
    const plugin = (loaded.openapiRoutes ??
      Object.values(loaded).find((v) => typeof v === 'function')) as Parameters<
      typeof app.register
    >[0];
    app.register(plugin, { prefix: '/api' });
  }
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 登録されたルートを `${METHOD} ${url}` のキー集合へ畳む(HEAD は GET の自動生成)。 */
function registeredKeys(): Set<string> {
  const out = new Set<string>();
  for (const route of REGISTERED) {
    if (!route.url.startsWith('/api')) continue;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) if (m !== 'HEAD') out.add(`${String(m)} ${route.url}`);
  }
  return out;
}

describe('ROUTE_POLICY の網羅', () => {
  // register 時に throw していれば beforeAll が失敗する。ここは「実際に register できた」
  // ことの確認と、件数が 0 に潰れていないことの見張り。
  it('registers every API route without tripping the policy assertion', () => {
    expect(registeredKeys().size).toBeGreaterThan(30);
  });

  it('has no dead entry: the table and the registered routes match exactly', () => {
    const registered = registeredKeys();
    const declared = new Set(Object.keys(ROUTE_POLICY));
    expect([...declared].filter((k) => !registered.has(k))).toEqual([]);
    expect([...registered].filter((k) => !declared.has(k))).toEqual([]);
  });

  // 既定は「変更系は editor 以上」。viewer へ開くなら理由を明文で残させる。
  it('lets no mutation stay open to viewer without a written reason', () => {
    const loose = Object.entries(ROUTE_POLICY)
      .filter(([key, level]) => /^(POST|PUT|PATCH|DELETE) /.test(key) && level === 'auth')
      .map(([key]) => key)
      .filter((key) => VIEWER_ALLOWED_MUTATIONS[key] === undefined);
    expect(loose).toEqual([]);
  });

  it('rejects a route that is missing from the table', async () => {
    const { assertRoutePolicy } = await import('../src/routes/routeGuards.js');
    expect(() =>
      assertRoutePolicy({ method: 'POST', url: '/api/brand-new' } as RouteOptions),
    ).toThrow(/ROUTE_POLICY/);
  });

  it('rejects a route whose guards disagree with the table', async () => {
    const { assertRoutePolicy } = await import('../src/routes/routeGuards.js');
    const { requireAuth } = await import('../src/middleware/auth.js');
    // 表では editor 宣言の generate に requireAuth だけを付けた形。
    expect(() =>
      assertRoutePolicy({
        method: 'POST',
        url: '/api/generate',
        preHandler: [requireAuth],
      } as unknown as RouteOptions),
    ).toThrow(/実際のガードは/);
  });
});

// 表と実装の乖離を潰す。ロールごとに全変更系ルートへ inject し、期待ステータスを
// 表から導いて突き合わせる。表を書き換えただけでガードを付け忘れたらここで落ちる。
describe('ロール別の実挙動', () => {
  const RANK: Record<string, number> = { public: 0, auth: 1, editor: 2, approver: 3, admin: 4 };
  const ROLE_RANK: Record<UserRole, number> = {
    viewer: 1,
    editor: 2,
    approver: 3,
    admin: 4,
  };

  /** パラメータ入りパスへ適当な実値を埋める(ガード判定はハンドラより前なので中身は任意)。 */
  const concrete = (url: string): string =>
    url.replace(/:([A-Za-z0-9_]+)/g, 'x').replace('/*', '/');

  for (const role of ['viewer', 'editor', 'approver', 'admin'] as UserRole[]) {
    it(`answers 403 exactly on the routes ${role} must not reach`, async () => {
      const mismatches: string[] = [];
      for (const [key, level] of Object.entries(ROUTE_POLICY)) {
        if (level === 'public') continue;
        // approver は editor 以上のロールだが、`admin` は approver ルートも通す一方
        // `approver` は admin ルートを通さない。数値の順位で判定する。
        const [method, url] = key.split(' ');
        const res = await app.inject({
          method: method as 'GET',
          url: concrete(url),
          headers: { cookie: `editor.sid=${role}` },
        });
        const shouldForbid = ROLE_RANK[role] < RANK[level];
        if (shouldForbid !== (res.statusCode === 403)) {
          mismatches.push(`${key} (${level}) → ${res.statusCode}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('answers 401 for an unauthenticated request on every guarded route', async () => {
    const unguarded: string[] = [];
    for (const [key, level] of Object.entries(ROUTE_POLICY)) {
      if (level === 'public') continue;
      const [method, url] = key.split(' ');
      const res = await app.inject({ method: method as 'GET', url: concrete(url) });
      if (res.statusCode !== 401) unguarded.push(`${key} → ${res.statusCode}`);
    }
    expect(unguarded).toEqual([]);
  });

  // 許可リストで書いてあることの確認。denylist(viewer を名指しで拒む)だと、台帳へ
  // ロールを増やした瞬間に既定で通ってしまう。
  it('forbids an unknown role on every guarded route', async () => {
    const passed: string[] = [];
    for (const [key, level] of Object.entries(ROUTE_POLICY)) {
      if (level === 'public' || level === 'auth') continue;
      const [method, url] = key.split(' ');
      const res = await app.inject({
        method: method as 'GET',
        url: concrete(url),
        headers: { cookie: 'editor.sid=superuser' },
      });
      if (res.statusCode !== 403) passed.push(`${key} → ${res.statusCode}`);
    }
    expect(passed).toEqual([]);
  });
});
