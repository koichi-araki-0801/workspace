// =============================================================================
// auth.store.dom.test.ts — 認証ストアの状態遷移と端末に残す痕跡
// =============================================================================
// login/logout/bootstrap は「前の利用者の痕跡が次の利用者へ残る」「再起動による
// 切断が理由なしでログイン画面へ落ちる」という共有端末特有の退行が無言の形で出る
// ため、権限 computed の値だけでなく localStorage/sessionStorage 側の副作用も検証する。
import { isOk } from '@editor/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import editorUser from '@/api/fixtures/users.json';
import { localRepositories, REPOS_KEY } from '@/api/repositories';
import {
  draftOwnerKey,
  K,
  LEGACY_UNDO_STACKS_KEY,
  legacyUndoStacksKeyV1,
  undoStacksKey,
} from '@/lib/storageKeys';
import { useAuthStore } from '@/stores/auth';

// fixture の editor ユーザーは mustChangePassword:true 個体で、平文パスワードもここから読む
// (直書きすると fixture 更新時にテストだけが古いパスワードを参照して壊れる)。
const EDITOR_PASSWORD = (editorUser as Array<{ username: string; password: string }>).find(
  (u) => u.username === 'editor',
)?.password as string;

function setupStore() {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  app.use(pinia);
  app.provide(REPOS_KEY, localRepositories);
  setActivePinia(pinia);
  return useAuthStore();
}

function setEpoch(value: string) {
  document.head.querySelector('meta[name="x-app-epoch"]')?.remove();
  const m = document.createElement('meta');
  m.setAttribute('name', 'x-app-epoch');
  m.setAttribute('content', value);
  document.head.appendChild(m);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.head.querySelector('meta[name="x-app-epoch"]')?.remove();
});

describe('useAuthStore.reset()', () => {
  it('sample cache(editor:sample:*)を消す(共有端末で次の利用者へファンド名を残さない)', () => {
    sessionStorage.setItem('editor:sample:510037', '{"fund":{"code":"510037","name":"F"}}');
    const store = setupStore();
    store.reset();
    expect(sessionStorage.getItem('editor:sample:510037')).toBeNull();
  });
});

describe('useAuthStore.login()', () => {
  it('成功で user と権限 computed が立ち、authEpoch マーカーを現 epoch で書く', async () => {
    setEpoch('e1');
    const store = setupStore();
    const res = await store.login('admin', 'admin');
    expect(isOk(res) && res.value).toBe(false); // mustChangePassword
    expect(store.isAuthenticated).toBe(true);
    expect(store.isAdmin).toBe(true);
    expect(store.isApprover).toBe(true);
    expect(store.mustChangePassword).toBe(false);
    expect(localStorage.getItem('editor:authEpoch')).toBe('e1');
    expect(store.sessionEndedReason).toBeNull();
  });

  it('approver は isApprover のみ真、editor は mustChangePassword が真', async () => {
    const a = setupStore();
    await a.login('approver', 'approver');
    expect(a.isAdmin).toBe(false);
    expect(a.isApprover).toBe(true);
    await a.logout();
    const res = await a.login('editor', EDITOR_PASSWORD); // users.json の値
    expect(isOk(res) && res.value).toBe(true);
    expect(a.mustChangePassword).toBe(true);
    expect(a.isApprover).toBe(false);
  });

  it('失敗では user が null のまま err を返す', async () => {
    const store = setupStore();
    const res = await store.login('admin', 'wrong');
    expect(isOk(res)).toBe(false);
    expect(store.isAuthenticated).toBe(false);
  });
});

describe('useAuthStore.logout()', () => {
  it('Undo ミラー(現行/旧 2 種)・下書き所属・authEpoch・sample cache を消す', async () => {
    const store = setupStore();
    await store.login('admin', 'admin');
    localStorage.setItem(undoStacksKey(), '{}');
    localStorage.setItem(LEGACY_UNDO_STACKS_KEY, '{}');
    localStorage.setItem(legacyUndoStacksKeyV1(), '{}');
    localStorage.setItem(draftOwnerKey(), '{}');
    sessionStorage.setItem('editor:sample:510037', '{}');
    const key = undoStacksKey();
    await store.logout();
    expect(store.user).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(LEGACY_UNDO_STACKS_KEY)).toBeNull();
    expect(localStorage.getItem(legacyUndoStacksKeyV1())).toBeNull();
    expect(localStorage.getItem(draftOwnerKey())).toBeNull();
    expect(localStorage.getItem('editor:authEpoch')).toBeNull();
    expect(sessionStorage.getItem('editor:sample:510037')).toBeNull();
  });
});

describe('useAuthStore.bootstrap()', () => {
  it('セッションがあれば user を復元し authEpoch を現 epoch へ更新する', async () => {
    setEpoch('e1');
    const first = setupStore();
    await first.login('admin', 'admin');
    const store = setupStore();
    await store.bootstrap();
    expect(store.ready).toBe(true);
    expect(store.user?.username).toBe('admin');
    expect(localStorage.getItem('editor:authEpoch')).toBe('e1');
  });

  it('未認証で前回 epoch と食い違えば sessionEndedReason を restart にしてマーカーを消す', async () => {
    setEpoch('e2');
    localStorage.setItem('editor:authEpoch', 'e1');
    const store = setupStore();
    await store.bootstrap();
    expect(store.user).toBeNull();
    expect(store.sessionEndedReason).toBe('restart');
    expect(localStorage.getItem('editor:authEpoch')).toBeNull();
  });

  it('未認証でも前回 epoch が無ければ理由は付かない', async () => {
    setEpoch('e2');
    const store = setupStore();
    await store.bootstrap();
    expect(store.sessionEndedReason).toBeNull();
  });

  it('me() が err を返しても user を復元せず ready にはなる', async () => {
    // セッションキーの中身が壊れていると local repo の JSON.parse が例外を投げ、
    // me() は err で返る(この経路は正常系のテストだけでは通らない)。
    localStorage.setItem(K.session, 'not-json');
    const store = setupStore();
    await store.bootstrap();
    expect(store.user).toBeNull();
    expect(store.ready).toBe(true);
  });
});
