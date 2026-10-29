// =============================================================================
// auth.store.dom.test.ts — 認証ストアの状態遷移と端末に残す痕跡
// =============================================================================
// login/logout/bootstrap は「前の利用者の痕跡が次の利用者へ残る」「再起動による
// 切断が理由なしでログイン画面へ落ちる」という共有端末特有の退行が無言の形で出る
// ため、権限 computed の値だけでなく localStorage/sessionStorage 側の副作用も検証する。
import { err, isOk, network } from '@editor/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import { REPOS_KEY, type Repositories } from '@/api/repositories';
import { draftOwner } from '@/lib/draftOwner';
import { draftOwnerKey, undoStacksKey } from '@/lib/storageKeys';
import { useAuthStore } from '@/stores/auth';
import { createFakeRepositories, TEST_LOGIN } from './helpers/fakeRepositories';

const { admin, approver, editor } = TEST_LOGIN;

// 偽の認証はセッションを 1 つ持つ。同じ偽 repo を provide したストア同士で共有するので、
// 「別のストアが bootstrap でセッションを復元する」経路も検証できる。
let repos: Repositories;

function setupStore() {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  app.use(pinia);
  app.provide(REPOS_KEY, repos);
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
  repos = createFakeRepositories();
  localStorage.clear();
  sessionStorage.clear();
  document.head.querySelector('meta[name="x-app-epoch"]')?.remove();
});

describe('useAuthStore.reset()', () => {
  it('sample cache(editor:sample:*)を消す(共有端末で次の利用者へファンド名を残さない)', () => {
    sessionStorage.setItem('editor:sample:950037', '{"fund":{"code":"950037","name":"F"}}');
    const store = setupStore();
    store.reset();
    expect(sessionStorage.getItem('editor:sample:950037')).toBeNull();
  });
});

describe('useAuthStore.login()', () => {
  it('成功で user と権限 computed が立ち、authEpoch マーカーを現 epoch で書く', async () => {
    setEpoch('e1');
    const store = setupStore();
    const res = await store.login(admin.username, admin.password);
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
    await a.login(approver.username, approver.password);
    expect(a.isAdmin).toBe(false);
    expect(a.isApprover).toBe(true);
    await a.logout();
    const res = await a.login(editor.username, editor.password);
    expect(isOk(res) && res.value).toBe(true);
    expect(a.mustChangePassword).toBe(true);
    expect(a.isApprover).toBe(false);
  });

  it('失敗では user が null のまま err を返す', async () => {
    const store = setupStore();
    const res = await store.login(admin.username, 'wrong');
    expect(isOk(res)).toBe(false);
    expect(store.isAuthenticated).toBe(false);
  });
});

describe('useAuthStore.logout()', () => {
  it('Undo ミラー・下書き所属・authEpoch・sample cache を消す', async () => {
    const store = setupStore();
    await store.login(admin.username, admin.password);
    localStorage.setItem(undoStacksKey(), '{}');
    localStorage.setItem(draftOwnerKey(), '{}');
    sessionStorage.setItem('editor:sample:950037', '{}');
    const key = undoStacksKey();
    const ownerKey = draftOwnerKey();
    await store.logout();
    expect(store.user).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    // キーごと消すと移行の猶予(`belongsToSession`)が再び開くため、空の記録を残す。
    expect(localStorage.getItem(ownerKey)).toBe('{}');
    expect(localStorage.getItem('editor:authEpoch')).toBeNull();
    expect(sessionStorage.getItem('editor:sample:950037')).toBeNull();
  });

  it('ログアウト後に別タブで開いた下書きを、移行の猶予で引き継がない', async () => {
    const store = setupStore();
    await store.login(admin.username, admin.password);
    draftOwner.claim('T1');
    await store.logout();
    // 別タブ = セッショントークンが違う
    sessionStorage.clear();
    await store.login(admin.username, admin.password);
    expect(draftOwner.belongsToSession('T1')).toBe(false);
  });

  it('旧形式の Undo ミラーのキーには触らない(読まれないだけで害はない)', async () => {
    const store = setupStore();
    await store.login(admin.username, admin.password);
    localStorage.setItem('editor:session:undo', '{}');
    await store.logout();
    expect(localStorage.getItem('editor:session:undo')).toBe('{}');
  });
});

describe('storageKeys', () => {
  it('旧キーの定数を持たない', async () => {
    const keys = await import('@/lib/storageKeys');
    for (const name of ['LEGACY_NOTES_KEY', 'LEGACY_UNDO_STACKS_KEY', 'legacyUndoStacksKeyV1']) {
      expect(name in keys).toBe(false);
    }
  });
});

describe('useAuthStore.bootstrap()', () => {
  it('セッションがあれば user を復元し authEpoch を現 epoch へ更新する', async () => {
    setEpoch('e1');
    const first = setupStore();
    await first.login(admin.username, admin.password);
    const store = setupStore();
    await store.bootstrap();
    expect(store.ready).toBe(true);
    expect(store.user?.username).toBe(admin.username);
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
    // me() が err を返す経路は正常系のテストだけでは通らないので、偽 repo で差し込む。
    repos = createFakeRepositories({ auth: { me: async () => err(network('接続できません')) } });
    const store = setupStore();
    await store.bootstrap();
    expect(store.user).toBeNull();
    expect(store.ready).toBe(true);
  });
});
