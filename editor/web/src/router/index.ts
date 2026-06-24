// =============================================================================
// index.ts — vue-router のルート定義と認証 navigation guard
// =============================================================================
import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type RouteRecordRaw,
} from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/features/auth/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/password-init',
    name: 'password-init',
    component: () => import('@/features/auth/PasswordInitView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('@/features/layout/MainLayout.vue'),
    children: [
      { path: '', redirect: { name: 'edit' } },
      {
        path: 'edit',
        name: 'edit',
        component: () => import('@/features/templates/EditTabView.vue'),
      },
      {
        path: 'create',
        name: 'create',
        component: () => import('@/features/templates/CreateTabView.vue'),
      },
      {
        path: 'compare',
        name: 'compare',
        component: () => import('@/features/compare/CompareView.vue'),
      },
      {
        path: 'history',
        name: 'history',
        component: () => import('@/features/templates/HistoryTabView.vue'),
      },
      {
        path: 'admin',
        name: 'admin',
        component: () => import('@/features/admin/AdminView.vue'),
        meta: { admin: true },
      },
    ],
  },
  {
    path: '/edit/:id',
    name: 'editor',
    component: () => import('@/features/editor/EditorView.vue'),
    props: true,
  },
  {
    path: '/preview/:id',
    name: 'preview',
    component: () => import('@/features/preview/PreviewView.vue'),
    props: true,
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'edit' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

/** guard が参照する auth ストアの最小形(Pinia ストアが構造的に満たす。テストで差し替え可)。 */
export interface AuthGuardState {
  ready: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  mustChangePassword: boolean;
  user: { username: string } | null;
  bootstrap: () => Promise<void>;
}

/**
 * 認証 navigation guard(`beforeEach` 本体)。テスト容易化のため auth ストアを引数で受け
 * (既定 `useAuthStore()`)、純粋に遷移可否/リダイレクト先を返す。public 以外は未認証なら
 * 必ず login へ送る(直 URL/ブックマーク/キャッシュ入場でもログイン画面を経由させる)。
 */
export async function authGuard(
  to: RouteLocationNormalized,
  auth: AuthGuardState = useAuthStore(),
): Promise<boolean | RouteLocationRaw> {
  if (!auth.ready) await auth.bootstrap();

  if (to.meta.public) return true;
  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } };
  // 初回パスワード変更が未了なら、どの保護ルートへ来ても password-init へ強制する
  // (直 URL で初期化を回避して他画面に入る抜け道を塞ぐ)。完了で `mustChangePassword` が
  // 下りて通常遷移へ戻る。
  if (auth.mustChangePassword && to.name !== 'password-init') {
    return {
      name: 'password-init',
      query: { username: auth.user?.username ?? '', redirect: to.fullPath },
    };
  }
  if (to.meta.admin && !auth.isAdmin) return { name: 'edit' };
  return true;
}

router.beforeEach((to) => authGuard(to));
