// =============================================================================
// mustChangePassword.test.ts — 初期パスワードのままのセッションをサーバ側で締める
// =============================================================================
// `要パスワード変更` の強制を SPA のルータガードだけに任せると、API を直接叩けば
// 初期パスワードのままフル権限で操作でき、承認まで通ってしまう。ここで固定するのは
// 「通す例外はパスワード変更・自分の確認・ログアウトの 3 経路だけ」という境界そのもの。
// config を import する前に `AUTH_REQUIRED=true` を立て、認可を有効化して検証する。
import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.AUTH_REQUIRED = 'true';

const reply = {} as FastifyReply;

/** cookie 経由のユーザ解決をモックせずに済むよう、`loadUser` が読む session module を差し替える。 */
vi.mock('../src/auth/session.js', () => ({
  cookieOptions: {},
  createSession: vi.fn(async () => 'sid'),
  destroySession: vi.fn(async () => {}),
  sessionIdFrom: (cookie?: string) => cookie,
  getSessionUser: async (sid: string) => ({
    id: sid,
    username: sid,
    displayName: sid,
    role: 'admin',
    disabled: false,
    // cookie に `must:` を付けたセッションだけ「初期パスワードのまま」とみなす。
    mustChangePassword: sid.startsWith('must:'),
  }),
}));

/** `routeOptions.url` は登録時のパターン。ルートは `/api` prefix 付きで登録される。 */
const reqFor = (sid: string, routeUrl: string): FastifyRequest =>
  ({
    headers: { cookie: sid },
    routeOptions: { url: routeUrl },
    url: routeUrl,
  }) as unknown as FastifyRequest;

describe('requireAuth と 要パスワード変更', () => {
  let requireAuth: typeof import('../src/middleware/auth.js').requireAuth;
  let allowed: readonly string[];

  beforeAll(async () => {
    const mod = await import('../src/middleware/auth.js');
    requireAuth = mod.requireAuth;
    allowed = mod.PASSWORD_CHANGE_ALLOWED_PATHS;
  });

  it('exempts exactly three routes (password change, me, logout)', () => {
    // 例外を増やすと初期パスワードのままのセッションで触れる API が増える。
    expect([...allowed].sort()).toEqual(['/auth/init-password', '/auth/logout', '/auth/me']);
  });

  it('lets a must-change session reach every exempt route', async () => {
    for (const path of allowed) {
      await expect(
        requireAuth(reqFor('must:admin', `/api${path}`), reply),
      ).resolves.toBeUndefined();
    }
  });

  it('forbids a must-change session on data routes (403)', async () => {
    for (const path of ['/api/templates', '/api/review-requests/r1/approve', '/api/users']) {
      await expect(requireAuth(reqFor('must:admin', path), reply)).rejects.toMatchObject({
        kind: 'forbidden',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
  });

  it('leaves a normal session untouched and fills request.user', async () => {
    const request = reqFor('admin', '/api/templates');
    await expect(requireAuth(request, reply)).resolves.toBeUndefined();
    expect(request.user?.username).toBe('admin');
  });

  it('falls back to the raw path when routeOptions is absent (query stripped)', async () => {
    const request = {
      headers: { cookie: 'must:admin' },
      url: '/api/auth/me?x=1',
    } as unknown as FastifyRequest;
    await expect(requireAuth(request, reply)).resolves.toBeUndefined();
  });
});
