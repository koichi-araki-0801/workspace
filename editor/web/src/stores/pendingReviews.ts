// =============================================================================
// pendingReviews.ts — 承認待ち申請一覧の Pinia ストア
// =============================================================================
import { isOk, type ReviewRequestMeta } from '@editor/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useReviewRepo } from '@/api/repositories';

/**
 * 処理待ち(pending|held)申請の共有ストア。上部ナビの件数バッジ・テンプレ一覧と
 * 編集画面の「承認待ち」バッジが同じ 1 回の取得を使い回すための置き場。可視範囲は
 * repository 側のロール制御に従う(approver|admin=全件 / editor=自分の申請のみ)ため、
 * 件数の意味はロールごとに「精査すべき申請」「自分の処理待ち申請」へ自然に分かれる。
 * 更新はポーリングせず、画面側の表示契機(MainLayout のタブ切替・EditorView のマウント)で
 * `refresh` を呼ぶ — 承認/却下/保留/申請の完了はいずれも画面遷移を伴うので、それで追随できる。
 */
export const usePendingReviewsStore = defineStore('pendingReviews', () => {
  const reviews = useReviewRepo();
  const items = ref<ReviewRequestMeta[]>([]);

  /**
   * 処理待ち一覧を取り直す。バッジ表示はベストエフォート(主導線はタブに残る)のため、
   * 取得失敗はエラー表示にせず空へ倒す — 前回値の残置だと、ログインし直した別ユーザーへ
   * 前ユーザーの件数を見せてしまう。
   * 保留(held)も「処理が済んでいない申請」としてバッジに数える。status 絞りをサーバへ
   * 渡さず全件を取り client で絞る(2 状態の OR をクエリ 1 回で表現できないため)。
   */
  async function refresh(): Promise<void> {
    const res = await reviews.listReviews({});
    items.value = isOk(res)
      ? res.value.filter((m) => m.status === 'pending' || m.status === 'held')
      : [];
  }

  /** 上部ナビの件数バッジ用の未処理件数。 */
  const count = computed(() => items.value.length);

  /** テンプレ id → 承認待ち申請(取得順 = 申請の新しい順)。一覧・編集画面のバッジが引く。 */
  const byTemplate = computed(() => {
    const map: Record<string, ReviewRequestMeta[]> = {};
    for (const m of items.value) {
      map[m.templateId] ??= [];
      map[m.templateId].push(m);
    }
    return map;
  });

  return { items, refresh, count, byTemplate };
});
