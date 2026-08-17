import { describe, expect, it } from 'vitest';
import type { RouteLocationNormalized } from 'vue-router';
import { type AuthGuardState, authGuard } from '@/router';

// 「URL 直遷移禁止」の CI 担保(§4)。guard の挙動を検証する。ルート表の access 宣言網羅・
// name→access 対応の不変条件は routePolicy.guard.test.ts へ移した(重複回避)。

function auth(over: Partial<AuthGuardState> = {}): AuthGuardState {
  return {
    ready: true,
    isAuthenticated: false,
    isAdmin: false,
    mustChangePassword: false,
    user: null,
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
      to('admin', '/admin', { access: 'admin' }),
    ];
    for (const r of protectedRoutes) {
      expect(await authGuard(r, auth())).toEqual({
        name: 'login',
        query: { redirect: r.fullPath },
      });
    }
  });

  it('public ルートは未認証でも通す', async () => {
    expect(await authGuard(to('login', '/login', { access: 'public' }), auth())).toBe(true);
    expect(
      await authGuard(to('password-init', '/password-init', { access: 'public' }), auth()),
    ).toBe(true);
  });

  it('access 未宣言は fail closed で auth 扱いになる(付け忘れ対策)', async () => {
    expect(await authGuard(to('edit', '/edit'), auth())).toEqual({
      name: 'login',
      query: { redirect: '/edit' },
    });
    expect(await authGuard(to('edit', '/edit'), auth({ isAuthenticated: true }))).toBe(true);
  });

  it('認証済みユーザーは保護ルートを通す', async () => {
    expect(await authGuard(to('edit', '/edit'), auth({ isAuthenticated: true }))).toBe(true);
  });

  it('非 admin は admin ルートから edit へ戻す', async () => {
    const res = await authGuard(
      to('admin', '/admin', { access: 'admin' }),
      auth({ isAuthenticated: true, isAdmin: false }),
    );
    expect(res).toEqual({ name: 'edit' });
  });

  it('admin は admin ルートを通す', async () => {
    const res = await authGuard(
      to('admin', '/admin', { access: 'admin' }),
      auth({ isAuthenticated: true, isAdmin: true }),
    );
    expect(res).toBe(true);
  });

  it('初回PW変更が未了なら保護ルートを password-init へ送る(redirect 付き)', async () => {
    const res = await authGuard(
      to('edit', '/edit'),
      auth({ isAuthenticated: true, mustChangePassword: true, user: { username: 'editor' } }),
    );
    expect(res).toEqual({
      name: 'password-init',
      query: { username: 'editor', redirect: '/edit' },
    });
  });

  it('初回PW変更が未了でも password-init 自身へは入れる', async () => {
    const res = await authGuard(
      to('password-init', '/password-init', { access: 'public' }),
      auth({ isAuthenticated: true, mustChangePassword: true, user: { username: 'editor' } }),
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
