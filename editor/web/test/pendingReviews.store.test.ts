// =============================================================================
// pendingReviews.store.test.ts — 承認待ち申請ストアの集計とロール別可視範囲
// =============================================================================
// local repo を実体のまま provide し、submit → refresh → `count`/`byTemplate` を検証する。
// ストアは setup 内で `useReviewRepo()`(inject)を使うため、Vue アプリへ pinia を載せて
// アプリ provide 経由で repository を差す(`app.runWithContext` で inject が解決される)。
import { err, network, type Result, type ReviewRequestMeta } from '@editor/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import { localAuthRepo } from '@/api/local/authRepo';
import { localReviewRepo } from '@/api/local/reviewRepo';
import { localTemplateRepo } from '@/api/local/templateRepo';
import { localRepositories, REPOS_KEY } from '@/api/repositories';
import { usePendingReviewsStore } from '@/stores/pendingReviews';

/** listReviews を差し替えられるフェイク付きで pinia + provide を組み、ストアを返す。 */
function setupStore(listReviews?: () => Promise<Result<ReviewRequestMeta[]>>) {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  app.use(pinia);
  app.provide(
    REPOS_KEY,
    listReviews
      ? {
          ...localRepositories,
          reviews: { ...localReviewRepo, listReviews },
        }
      : localRepositories,
  );
  setActivePinia(pinia);
  return usePendingReviewsStore();
}

async function login(username: string, password: string): Promise<void> {
  const r = await localAuthRepo.login({ username, password });
  if (!r.ok) throw new Error(`login failed: ${username}`);
}

/** fixtures 由来のテンプレを先頭から n 件返す(足りなければテストを素通しさせる)。 */
async function templates(n: number) {
  const list = await localTemplateRepo.listTemplates({});
  if (!list.ok || list.value.length < n) return null;
  return list.value.slice(0, n);
}

async function submit(templateId: string, fundCode: string): Promise<void> {
  const r = await localReviewRepo.submitReview({
    templateId,
    html: '<p>申請本文</p>',
    css: '.a{}',
    fundCode,
    origin: 'edit',
  });
  if (!r.ok) throw new Error('submit failed');
}

beforeEach(() => localStorage.clear());

describe('usePendingReviewsStore', () => {
  it('refresh() が pending をテンプレ id ごとに集計する', async () => {
    await login('admin', 'admin');
    const ts = await templates(2);
    if (!ts) return;
    const [t1, t2] = ts;
    await submit(t1.id, t1.attributes.fundCode);
    await submit(t1.id, t1.attributes.fundCode);
    await submit(t2.id, t2.attributes.fundCode);

    const store = setupStore();
    expect(store.count).toBe(0); // refresh 前は空
    await store.refresh();
    expect(store.count).toBe(3);
    expect(store.byTemplate[t1.id]).toHaveLength(2);
    expect(store.byTemplate[t2.id]).toHaveLength(1);
    expect(store.byTemplate[t1.id][0].status).toBe('pending');
  });

  it('approver 以外は自分の申請だけが件数に乗る(可視範囲は repo のロール制御に従う)', async () => {
    // admin が 1 件申請 → editor でログインし直すと他人の申請は見えない。
    await login('admin', 'admin');
    const ts = await templates(1);
    if (!ts) return;
    const [t1] = ts;
    await submit(t1.id, t1.attributes.fundCode);

    await login('editor', 'editor');
    const store = setupStore();
    await store.refresh();
    expect(store.count).toBe(0);

    // editor 自身の申請は乗る。
    await submit(t1.id, t1.attributes.fundCode);
    await store.refresh();
    expect(store.count).toBe(1);
  });

  it('取得失敗は空へ倒す(前ユーザーの件数を残さない・throw しない)', async () => {
    await login('admin', 'admin');
    const ts = await templates(1);
    if (!ts) return;
    const [t1] = ts;
    await submit(t1.id, t1.attributes.fundCode);

    let fail = false;
    const store = setupStore(() =>
      fail
        ? Promise.resolve(err(network('接続できません')))
        : localReviewRepo.listReviews({ status: 'pending' }),
    );
    await store.refresh();
    expect(store.count).toBe(1);

    fail = true;
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.count).toBe(0);
    expect(store.byTemplate[t1.id]).toBeUndefined();
  });

  it('pending が無ければ byTemplate は空オブジェクト', async () => {
    await login('admin', 'admin');
    const store = setupStore();
    await store.refresh();
    expect(store.count).toBe(0);
    expect(Object.keys(store.byTemplate)).toHaveLength(0);
  });
});
