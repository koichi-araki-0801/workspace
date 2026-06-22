import { describe, expect, it } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import { type AuthGuardState, authGuard, routes } from '@/router';

// 「URL 直遷移禁止」の CI 担保(§4)。guard の挙動と、ルート表の不変条件(public は login と
// password-init だけ)を検証する。ルート表テストは将来 `/edit/:id` 等に誤って public が付く
// 回帰を検出する。

function auth(over: Partial<AuthGuardState> = {}): AuthGuardState {
  return {
    ready: true,
    isAuthenticated: false,
    isAdmin: false,
    bootstrap: async () => {},
    ...over,
  };
}

function to(
  name: string,
  fullPath: string,
  meta: Record<string, unknown> = {},
): RouteLocationNormalized {
  return { name, fullPath, meta } as unknown as RouteLocationNormalized;
}

describe('authGuard', () => {
  it('未認証なら保護ルートを login へ送る(redirect 付き)', async () => {
    const protectedRoutes = [
      to('editor', '/edit/abc'),
      to('preview', '/preview/abc'),
      to('edit', '/edit'),
      to('compare', '/compare'),
      to('history', '/history'),
      to('admin', '/admin', { admin: true }),
    ];
    for (const r of protectedRoutes) {
      expect(await authGuard(r, auth())).toEqual({
        name: 'login',
        query: { redirect: r.fullPath },
      });
    }
  });

  it('public ルートは未認証でも通す', async () => {
    expect(await authGuard(to('login', '/login', { public: true }), auth())).toBe(true);
    expect(await authGuard(to('password-init', '/password-init', { public: true }), auth())).toBe(
      true,
    );
  });

  it('認証済みユーザーは保護ルートを通す', async () => {
    expect(await authGuard(to('edit', '/edit'), auth({ isAuthenticated: true }))).toBe(true);
  });

  it('非 admin は admin ルートから edit へ戻す', async () => {
    const res = await authGuard(
      to('admin', '/admin', { admin: true }),
      auth({ isAuthenticated: true, isAdmin: false }),
    );
    expect(res).toEqual({ name: 'edit' });
  });

  it('admin は admin ルートを通す', async () => {
    const res = await authGuard(
      to('admin', '/admin', { admin: true }),
      auth({ isAuthenticated: true, isAdmin: true }),
    );
    expect(res).toBe(true);
  });

  it('ready=false のとき bootstrap を呼ぶ', async () => {
    let called = false;
    const bootstrap = async () => {
      called = true;
    };
    await authGuard(to('edit', '/edit'), auth({ ready: false, bootstrap }));
    expect(called).toBe(true);
  });
});

interface RouteLike {
  name?: string | symbol;
  meta?: { public?: boolean; admin?: boolean };
  children?: RouteLike[];
}

function flatten(rs: RouteLike[]): RouteLike[] {
  return rs.flatMap((r) => [r, ...(r.children ? flatten(r.children) : [])]);
}

describe('routes invariants', () => {
  it('public は login と password-init だけ(deep-link バイパス防止)', () => {
    const publicNames = flatten(routes as unknown as RouteLike[])
      .filter((r) => r.meta?.public)
      .map((r) => r.name)
      .sort();
    expect(publicNames).toEqual(['login', 'password-init']);
  });

  it('admin ルートは admin 専用フラグを持つ', () => {
    const admin = flatten(routes as unknown as RouteLike[]).find((r) => r.name === 'admin');
    expect(admin?.meta?.admin).toBe(true);
  });
});
