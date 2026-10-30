// =============================================================================
// useReviewDiff.ts — 承認画面のデータ取得と承認/却下アクションの composable
// =============================================================================
// `ReviewDetail` が抱えていた「申請を読み現行版と diff して状態に載せる」「承認/却下を
// repo へ投げる」ロジックを View から切り出す(他 feature が service/composable へ委譲するのと
// 揃える)。トースト/画面遷移といった presentation は View 側に残し、ここは状態と Result を返す。
import type {
  ApproveReviewResult,
  HtmlDiff,
  Result,
  ReviewPartDecision,
  ReviewRequest,
  ReviewRequestMeta,
  UpdateReviewPartDecisionsRequest,
} from '@editor/shared';

import {
  isErr,
  REVIEW_ALREADY_DECIDED,
  REVIEW_BASE_CHANGED,
  REVIEW_NOT_REVIEWABLE,
  REVIEW_PART_DECISION_TRANSITION,
  REVIEW_RENDER_ERROR,
} from '@editor/shared';
import { ref } from 'vue';
import { useReviewRepo } from '@/api/repositories';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { describePartKeys } from './reviewDecisionState';
import type { ReviewChangeRow, ReviewChangeSummary } from './services/reviewDiffService';
import { useReviewDiffService } from './services/reviewDiffService';

export function useReviewDiff(reqId: () => string) {
  const diffService = useReviewDiffService();
  const reviews = useReviewRepo();
  const { loading, run: runLoad } = useAsyncResult();
  const { loading: deciding, run: runDecide } = useAsyncResult();

  const review = ref<ReviewRequest | null>(null);
  const changes = ref<ReviewChangeRow[]>([]);
  const diff = ref<HtmlDiff | null>(null);
  const summary = ref<ReviewChangeSummary>({ total: 0, changed: 0, added: 0, removed: 0 });
  const cssBefore = ref('');
  const cssAfter = ref('');
  /** after(申請版)の本文全体 HTML。「PDF を開いて確認」が使う。 */
  const afterBodyHtml = ref('');

  /** 資源上限で差分に出せなかった領域があるか(承認者へ必ず見せる)。 */
  const truncated = ref(false);
  /** ファンド共通 CSS が現行版と変わっているか(HTML 差分 0 でも承認で上書きされる)。 */
  const cssChanged = ref(false);
  /** 申請 CSS に印刷時だけ効く規則があるか(承認者の見えと成果物が乖離する)。 */
  const printOnlyCss = ref(false);
  /** 申請者の CSS が文字を生むか(紙面にだけ出て、右欄の文字の差分に出ない)。 */
  const cssGeneratedText = ref(false);
  const loadError = ref(false);
  /**
   * 作成経路の申請を承認画面に出せない理由(サーバが描けなかったなど)。読み込みの失敗の汎用の文言
   * (「時間をおいて」)の代わりに出す。申請し直してもらうしかない失敗なので、待っても直らない。
   */
  const renderErrorMessage = ref<string | null>(null);

  /**
   * 申請を読み、現行版と diff してパーツ行・集計・CSS を状態へ載せる。失敗は loadError に倒す。
   * 読めたかを返す(読み直しのあとに「画面を読み直しました」と言ってよいかの判定に使う)。
   */
  async function load(): Promise<boolean> {
    loadError.value = false;
    renderErrorMessage.value = null;
    const res = await runLoad(() => diffService.buildDiff(reqId()));
    if (isErr(res)) {
      loadError.value = true;
      if (res.error.code === REVIEW_RENDER_ERROR) renderErrorMessage.value = res.error.message;
      return false;
    }
    review.value = res.value.review;
    changes.value = res.value.changes;
    diff.value = res.value.diff;
    summary.value = res.value.summary;
    cssBefore.value = res.value.cssBefore;
    cssAfter.value = res.value.cssAfter;
    afterBodyHtml.value = res.value.afterBodyHtml;
    truncated.value = res.value.truncated;
    cssChanged.value = res.value.cssChanged;
    printOnlyCss.value = res.value.printOnlyCss;
    cssGeneratedText.value = res.value.cssGeneratedText;
    return true;
  }

  /**
   * 判定・最終確定・申請ごと却下の失敗のうち、呼び出し側が読み直して自分の文言で知らせるもの。
   * `useAsyncResult` のトースト(サーバの文言)と二重に出さないよう黙らせる。
   */
  const DECIDE_QUIET_CODES = [
    REVIEW_ALREADY_DECIDED,
    REVIEW_PART_DECISION_TRANSITION,
    REVIEW_BASE_CHANGED,
    REVIEW_NOT_REVIEWABLE,
  ];
  /** 判定・最終確定の文言に並ぶパーツのキーを、右欄の番号とパーツ名へ読み替える。 */
  const describe = (message: string) => describePartKeys(message, changes.value);

  /** 承認(実ファイル反映)。反映後メタ + 並行性警告を Result で返す(遷移/トーストは View)。 */
  function approve(comment?: string): Promise<Result<ApproveReviewResult>> {
    return runDecide(() => reviews.approveReview(reqId(), { comment }), {
      quietCodes: DECIDE_QUIET_CODES,
      describe,
    });
  }

  /** 却下(実ファイル非更新)。 */
  function reject(comment?: string): Promise<Result<ReviewRequestMeta>> {
    return runDecide(() => reviews.rejectReview(reqId(), { comment }), {
      quietCodes: DECIDE_QUIET_CODES,
      describe,
    });
  }

  /** パーツ判定をまとめて保存し、保存後の判定(応答の `partDecisions`)を返す。 */
  function updatePartDecisions(
    input: UpdateReviewPartDecisionsRequest,
  ): Promise<Result<ReviewPartDecision[]>> {
    return runDecide(() => reviews.updatePartDecisions(reqId(), input), {
      quietCodes: DECIDE_QUIET_CODES,
      describe,
    });
  }

  return {
    review,
    changes,
    diff,
    summary,
    cssBefore,
    cssAfter,
    afterBodyHtml,
    truncated,
    cssChanged,
    printOnlyCss,
    cssGeneratedText,
    loadError,
    renderErrorMessage,
    loading,
    deciding,
    load,
    approve,
    reject,
    updatePartDecisions,
  };
}
