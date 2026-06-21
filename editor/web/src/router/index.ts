// =============================================================================
// index.ts — vue-router のルート定義と認証 navigation guard
// =============================================================================
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
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

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.bootstrap();

  if (to.meta.public) return true;
  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } };
  if (to.meta.admin && !auth.isAdmin) return { name: 'edit' };
  return true;
});
