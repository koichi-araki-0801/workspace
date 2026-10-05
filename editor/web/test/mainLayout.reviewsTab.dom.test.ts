// =============================================================================
// mainLayout.reviewsTab.dom.test.ts — 上部の承認タブが編集タブのテンプレートを対象にすること
// =============================================================================
// 承認タブは「編集タブで開いているテンプレート 1 件」の申請を扱う。前回の `?template=A` を
// タブの戻り先として覚えていると、編集タブで B を開いた後に上部の承認タブを押しても A が出る。
import { ok } from '@editor/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { REPOS_KEY } from '@/api/repositories';
import MainLayout from '@/features/layout/MainLayout.vue';

const Empty = defineComponent({ render: () => h('div') });

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: MainLayout,
        children: [
          { path: 'edit', name: 'edit', component: Empty },
          { path: 'create', name: 'create', component: Empty },
          { path: 'reviews', name: 'reviews', component: Empty },
          { path: 'merge', name: 'merge', component: Empty },
          { path: 'compare', name: 'compare', component: Empty },
          { path: 'history', name: 'history', component: Empty },
          { path: 'edit/:id', name: 'editor', component: Empty },
        ],
      },
    ],
  });
}

async function mountAt(path: string) {
  const router = makeRouter();
  await router.push(path);
  await router.isReady();
  const reviews = { listReviews: async () => ok([]) };
  const w = mount(MainLayout, {
    global: {
      plugins: [router],
      provide: { [REPOS_KEY as symbol]: { reviews } },
      stubs: { ThemeToggle: true, UserMenu: true, RouterView: true },
    },
  });
  await flushPromises();
  return { w, router };
}

const reviewsTabHref = (w: Awaited<ReturnType<typeof mountAt>>['w']) =>
  w
    .findAll('nav a')
    .find((a) => a.text().includes('承認') || a.text().includes('申請状況'))
    ?.attributes('href');

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('MainLayout の承認タブ', () => {
  it('前に開いた ?template=A を戻り先に使わず、編集タブの現在のテンプレートへ解決させる', async () => {
    const { w, router } = await mountAt('/reviews?template=A');
    await router.push('/edit/B');
    await flushPromises();
    expect(reviewsTabHref(w)).toBe('/reviews');
  });
});
