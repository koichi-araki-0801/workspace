// =============================================================================
// ReviewRepository.ts — 確定保存の精査者承認ワークフロー集約
// =============================================================================
// 役割: 確定保存(実ファイル `data/templates` + git への反映)を「申請 → 承認」の 2 段に
// 分ける契約。申請(`submitReview`)は実ファイルを更新せず承認待ちとして積み、承認
// (`approveReview`、approver|admin のみ)時に限り実ファイルへ反映する。編集タブ・作成タブの
// 両経路を一律にゲートする(`index.ts` の `ReviewRequest*` 型を見よ)。
// web の `local`(localStorage ミラー)/`rest`(server API)両実装がこの interface を満たす。
import type {
  ApproveReviewResult,
  ReviewDecisionRequest,
  ReviewRequest,
  ReviewRequestMeta,
  ReviewStatus,
  SubmitReviewRequest,
} from '../index.js';
import type { Result } from '../result.js';

/** 承認キューの絞り込み(状態)。未指定は全件。 */
export interface ReviewListFilter {
  status?: ReviewStatus;
}

/**
 * 確定保存の精査者承認集約。`submitReview` は実ファイル非更新の申請を作り、
 * `approveReview` だけが実ファイル + git へ反映する(唯一の関所)。`listReviews` は
 * サーバ側で actor のロールに応じて絞る(approver|admin は全件、editor は自分の申請のみ)。
 */
export interface ReviewRepository {
  /** 確定保存を申請する(pending 作成・実ファイル非更新)。 */
  submitReview(req: SubmitReviewRequest): Promise<Result<ReviewRequestMeta>>;
  /** 申請一覧(承認キュー)。状態で絞り込める。 */
  listReviews(filter?: ReviewListFilter): Promise<Result<ReviewRequestMeta[]>>;
  /** 申請 1 件を本体込みで取得する(承認画面のプレビュー用)。 */
  getReview(reqId: string): Promise<Result<ReviewRequest>>;
  /** 承認して実ファイルへ反映する(approver|admin のみ)。反映後メタ + 並行性警告を返す。 */
  approveReview(
    reqId: string,
    decision: ReviewDecisionRequest,
  ): Promise<Result<ApproveReviewResult>>;
  /** 却下する(approver|admin のみ)。理由は `decision.comment`。 */
  rejectReview(reqId: string, decision: ReviewDecisionRequest): Promise<Result<ReviewRequestMeta>>;
  /**
   * 保留する(approver|admin のみ)。判断を保留して後で戻る・他者へ相談するための状態で、
   * 承認/差し戻しは pending と held のどちらからでも行える(保留解除の専用操作は無い)。
   */
  holdReview(reqId: string, decision: ReviewDecisionRequest): Promise<Result<ReviewRequestMeta>>;
}
