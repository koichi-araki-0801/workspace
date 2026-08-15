// =============================================================================
// routePolicy.guard.test.ts — router 認可宣言の網羅ガード
// =============================================================================
// ここでの検査は defense in depth。実権限の最終関門はサーバ側 ROUTE_POLICY
// (`server/src/routes/routeGuards.ts`)で、本テストは UI 側の宣言漏れ(fail-open)を防ぐ。
//
// `meta.access` は 'public' | 'auth' | 'admin' の 3 値。未宣言のルートは authGuard が
// fail closed で 'auth' 扱いするが、それに頼らせず**全リーフルートへ明示宣言を強制**する
// (付け忘れの検出を「たまたま安全側に倒れる」実行時挙動でなく、宣言の有無という機械的な
// 事実に基づかせるため)。
import { describe, expect, it } from 'vitest';
import { routes } from '@/router';

interface RouteLike {
  name?: string | symbol;
  component?: unknown;
  redirect?: unknown;
  meta?: { access?: string };
  children?: RouteLike[];
}

function flatten(rs: RouteLike[]): RouteLike[] {
  return rs.flatMap((r) => [r, ...(r.children ? flatten(r.children) : [])]);
}

const ACCESS_LEVELS = new Set(['public', 'auth', 'admin']);

describe('router 認可宣言の網羅性', () => {
  const all = flatten(routes as unknown as RouteLike[]);
  // redirect 専用レコードは実体を持たず遷移先で改めてガードされるため対象外
  const declarable = all.filter((r) => r.component !== undefined && r.redirect === undefined);

  it('component を持つ全レコードが access を宣言している', () => {
    for (const r of declarable) {
      expect(r.meta?.access, `route name=${String(r.name)} は access 未宣言`).toBeDefined();
      expect(ACCESS_LEVELS.has(r.meta?.access ?? '')).toBe(true);
    }
  });

  it('name → access の対応表が実ルート表と一致する(追加・変更時の更新を強制)', () => {
    const table: Record<string, string> = {};
    for (const r of declarable) {
      if (typeof r.name === 'string') table[r.name] = r.meta?.access ?? '';
    }
    expect(table).toEqual({
      login: 'public',
      'password-init': 'public',
      edit: 'auth',
      create: 'auth',
      compare: 'auth',
      reviews: 'auth',
      'review-detail': 'auth',
      history: 'auth',
      merge: 'auth',
      admin: 'admin',
      editor: 'auth',
      preview: 'auth',
    });
  });
});
