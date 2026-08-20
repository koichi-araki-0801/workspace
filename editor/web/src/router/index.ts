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

/** ルートの認可区分。未宣言時の既定は authGuard 側で 'auth' へ fail closed する。 */
export type RouteAccess = 'public' | 'auth' | 'admin';

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/features/auth/LoginView.vue'),
    meta: { access: 'public' },
  },
  {
    path: '/password-init',
    name: 'password-init',
    component: () => import('@/features/auth/PasswordInitView.vue'),
    meta: { access: 'public' },
  },
  {
    path: '/',
    component: () => import('@/features/layout/MainLayout.vue'),
    // レイアウト自体は非表示の入れ物で、実際の可否は各 children が個別に宣言する
    // (vue-router の meta マージでは後段の children 側が勝つため実効はここではないが、
    // 「component を持つ全レコードが access を宣言する」網羅則を満たすため明示する)。
    meta: { access: 'auth' },
    children: [
      { path: '', redirect: { name: 'edit' } },
      {
        path: 'edit',
        name: 'edit',
        component: () => import('@/features/templates/EditTabView.vue'),
        meta: { access: 'auth' },
      },
      {
        path: 'create',
        name: 'create',
        component: () => import('@/features/templates/CreateTabView.vue'),
        meta: { access: 'auth' },
      },
      {
        path: 'compare',
        name: 'compare',
        component: () => import('@/features/compare/CompareView.vue'),
        meta: { access: 'auth' },
      },
      {
        path: 'reviews',
        name: 'reviews',
        component: () => import('@/features/reviews/ReviewQueueView.vue'),
        meta: { access: 'auth' },
      },
      {
        path: 'reviews/:reqId',
        name: 'review-detail',
        component: () => import('@/features/reviews/ReviewDiffView.vue'),
        props: true,
        meta: { access: 'auth' },
      },
      {
        path: 'history',
        name: 'history',
        component: () => import('@/features/templates/HistoryTabView.vue'),
        meta: { access: 'auth' },
      },
      {
        path: 'merge',
        name: 'merge',
        component: () => import('@/features/merge/MergeTabView.vue'),
        meta: { access: 'auth' },
      },
      {
        path: 'admin',
        name: 'admin',
        component: () => import('@/features/admin/AdminView.vue'),
        meta: { access: 'admin' },
      },
    ],
  },
  {
    path: '/edit/:id',
    name: 'editor',
    component: () => import('@/features/editor/EditorView.vue'),
    props: true,
    meta: { access: 'auth' },
  },
  {
    path: '/preview/:id',
    name: 'preview',
    component: () => import('@/features/preview/PreviewView.vue'),
    props: true,
    meta: { access: 'auth' },
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

  // 未宣言(付け忘れ)は fail closed で 'auth' 扱いにする(opt-in の admin フラグ方式だと
  // 付け忘れた新規ルートが全認証ユーザへ開いてしまう)。
  const access = (to.meta.access as RouteAccess | undefined) ?? 'auth';
  // 認証済みでログイン画面へ来た場合(戻る操作・ブックマーク)は public でも素通しせず、
  // 下の認証済み向け判定へ合流させる — ログイン画面に留まらせない。
  const loginWhileAuthenticated = to.name === 'login' && auth.isAuthenticated;
  if (access === 'public' && !loginWhileAuthenticated) return true;
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
  if (loginWhileAuthenticated) return { name: 'edit' };
  if (access === 'admin' && !auth.isAdmin) return { name: 'edit' };
  return true;
}

router.beforeEach((to) => authGuard(to));
