// =============================================================================
// pendingReviews.store.test.ts — 承認待ち申請ストアの集計と失敗時の倒し方
// =============================================================================
// 偽 repo の `listReviews` が返す一覧から、`count`/`byTemplate` を検証する。可視範囲の
// ロール制御は server(REST)の責務で、ストアは repo が返した範囲をそのまま数える。
// ストアは setup 内で `useReviewRepo()`(inject)を使うため、Vue アプリへ pinia を載せて
// アプリ provide 経由で偽 repo を差す。値はすべてテスト用のダミー。
import {
  err,
  network,
  ok,
  type Result,
  type ReviewRequestMeta,
  type ReviewStatus,
} from '@editor/shared';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import { createApp } from 'vue';
import { REPOS_KEY } from '@/api/repositories';
import { usePendingReviewsStore } from '@/stores/pendingReviews';
import { createFakeRepositories } from './helpers/fakeRepositories';

/** `listReviews` だけを持つ偽 repo で pinia + provide を組み、ストアを返す。 */
function setupStore(listReviews: () => Promise<Result<ReviewRequestMeta[]>>) {
  const app = createApp({ render: () => null });
  const pinia = createPinia();
  app.use(pinia);
  app.provide(REPOS_KEY, createFakeRepositories({ reviews: { listReviews } }));
  setActivePinia(pinia);
  return usePendingReviewsStore();
}

let seq = 0;
/** テスト用の申請メタを 1 件作る。 */
function meta(templateId: string, status: ReviewStatus = 'pending'): ReviewRequestMeta {
  return {
    id: `test-req-${++seq}`,
    templateId,
    attributes: { companyCode: 'TEST', fundCode: '000001', editionType: '交付版' },
    origin: 'edit',
    status,
    submittedBy: 'test-editor',
    submittedAt: '2026-01-01T00:00:00Z',
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: null,
  };
}

describe('usePendingReviewsStore', () => {
  it('refresh() が pending をテンプレ id ごとに集計する', async () => {
    const list = [meta('T1'), meta('T1'), meta('T2'), meta('T2', 'approved')];
    const store = setupStore(async () => ok(list));
    expect(store.count).toBe(0); // refresh 前は空
    await store.refresh();
    expect(store.count).toBe(3);
    expect(store.byTemplate.T1).toHaveLength(2);
    expect(store.byTemplate.T2).toHaveLength(1);
    expect(store.byTemplate.T1[0].status).toBe('pending');
  });

  it('repo が返した範囲だけを数える(可視範囲の絞り込みはしない)', async () => {
    // ロールによる絞り込みは server が行う。ストアが独自に足し引きすると、
    // バッジの件数と承認タブの一覧が食い違う。
    let list = [meta('T1')];
    const store = setupStore(async () => ok(list));
    await store.refresh();
    expect(store.count).toBe(1);

    list = [];
    await store.refresh();
    expect(store.count).toBe(0);
  });

  it('取得失敗は空へ倒す(前ユーザーの件数を残さない・throw しない)', async () => {
    let fail = false;
    const store = setupStore(async () =>
      fail ? err(network('接続できません')) : ok([meta('T1')]),
    );
    await store.refresh();
    expect(store.count).toBe(1);

    fail = true;
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.count).toBe(0);
    expect(store.byTemplate.T1).toBeUndefined();
  });

  it('pending が無ければ byTemplate は空オブジェクト', async () => {
    const store = setupStore(async () => ok([meta('T1', 'rejected')]));
    await store.refresh();
    expect(store.count).toBe(0);
    expect(Object.keys(store.byTemplate)).toHaveLength(0);
  });
});
