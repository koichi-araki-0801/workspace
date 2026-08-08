// =============================================================================
// useReviewDiff.ts — 承認画面のデータ取得と承認/却下アクションの composable
// =============================================================================
// `ReviewDiffView` が抱えていた「申請を読み現行版と diff して状態に載せる」「承認/却下を
// repo へ投げる」ロジックを View から切り出す(他 feature が service/composable へ委譲するのと
// 揃える)。トースト/画面遷移といった presentation は View 側に残し、ここは状態と Result を返す。
import type { ApproveReviewResult, Result, ReviewRequest, ReviewRequestMeta } from '@editor/shared';
import { isErr } from '@editor/shared';
import { ref } from 'vue';
import { useReviewRepo } from '@/api/repositories';
import { useAsyncResult } from '@/lib/useAsyncResult';
import type { ReviewChangeSummary, ReviewPartRow } from './services/reviewDiffService';
import { useReviewDiffService } from './services/reviewDiffService';

export function useReviewDiff(reqId: () => string) {
  const diffService = useReviewDiffService();
  const reviews = useReviewRepo();
  const { loading, run: runLoad } = useAsyncResult();
  const { loading: deciding, run: runDecide } = useAsyncResult();

  const review = ref<ReviewRequest | null>(null);
  const rows = ref<ReviewPartRow[]>([]);
  const summary = ref<ReviewChangeSummary>({ total: 0, changed: 0, added: 0, removed: 0 });
  const cssBefore = ref('');
  const cssAfter = ref('');
  /** 資源上限で差分に出せなかった領域があるか(承認者へ必ず見せる。再スキャン F9)。 */
  const truncated = ref(false);
  const loadError = ref(false);

  /** 申請を読み、現行版と diff してパーツ行・集計・CSS を状態へ載せる。失敗は loadError に倒す。 */
  async function load(): Promise<void> {
    loadError.value = false;
    const res = await runLoad(() => diffService.buildDiff(reqId()));
    if (isErr(res)) {
      loadError.value = true;
      return;
    }
    review.value = res.value.review;
    rows.value = res.value.rows;
    summary.value = res.value.summary;
    cssBefore.value = res.value.cssBefore;
    cssAfter.value = res.value.cssAfter;
    truncated.value = res.value.truncated;
  }

  /** 承認(実ファイル反映)。反映後メタ + 並行性警告を Result で返す(遷移/トーストは View)。 */
  function approve(comment?: string): Promise<Result<ApproveReviewResult>> {
    return runDecide(() => reviews.approveReview(reqId(), { comment }));
  }

  /** 却下(実ファイル非更新)。 */
  function reject(comment?: string): Promise<Result<ReviewRequestMeta>> {
    return runDecide(() => reviews.rejectReview(reqId(), { comment }));
  }

  return {
    review,
    rows,
    summary,
    cssBefore,
    cssAfter,
    truncated,
    loadError,
    loading,
    deciding,
    load,
    approve,
    reject,
  };
}
