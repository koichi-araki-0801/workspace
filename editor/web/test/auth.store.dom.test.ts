// =============================================================================
// auth.store.dom.test.ts — 認証ストアの reset()(401 由来)が端末に残す状態
// =============================================================================
// reset() はログアウト API を叩かない 401 経由の state クリアで、logout() と同じ
// 「次の利用者に前の利用者の痕跡を残さない」要件を満たす必要がある。ここでは
// sessionStorage の sample cache(`editor:sample:*`)が reset() でも消えることを主張する。
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import { localRepositories, REPOS_KEY } from '@/api/repositories';
import { useAuthStore } from '@/stores/auth';

function setupStore() {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  app.use(pinia);
  app.provide(REPOS_KEY, localRepositories);
  setActivePinia(pinia);
  return useAuthStore();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('useAuthStore.reset()', () => {
  it('sample cache(editor:sample:*)を消す(共有端末で次の利用者へファンド名を残さない)', () => {
    sessionStorage.setItem('editor:sample:510037', '{"fund":{"code":"510037","name":"F"}}');
    const store = setupStore();
    store.reset();
    expect(sessionStorage.getItem('editor:sample:510037')).toBeNull();
  });
});
