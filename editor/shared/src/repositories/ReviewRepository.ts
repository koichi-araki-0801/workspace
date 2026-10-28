// =============================================================================
// ReviewRepository.ts — 確定保存の精査者承認ワークフロー集約
// =============================================================================
// 役割: 確定保存(実ファイル `<dataRoot>/templates` + git への反映)を「申請 → 承認」の 2 段に
// 分ける契約。申請(`submitReview`)は実ファイルを更新せず承認待ちとして積み、承認
// (`approveReview`、approver|admin のみ)時に限り実ファイルへ反映する。編集タブ・作成タブの
// 両経路を一律にゲートする(`index.ts` の `ReviewRequest*` 型を見よ)。
// web の `rest`(server API)の実装(とテスト用の偽物)がこの interface を満たす。
import type {
  ApproveReviewResult,
  ReviewDecisionRequest,
  ReviewPartDecision,
  ReviewRequest,
  ReviewRequestMeta,
  ReviewStatus,
  SubmitReviewRequest,
  UpdateReviewPartDecisionsRequest,
} from '../index.js';
import type { Result } from '../result.js';

/** 申請一覧の絞り込み(状態)。未指定は全件。 */
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
  /** 申請一覧。状態で絞り込める。 */
  listReviews(filter?: ReviewListFilter): Promise<Result<ReviewRequestMeta[]>>;
  /**
   * 申請1件を本体とパーツ判定情報込みで取得する。
   * 旧reviewで判定情報が無い場合、読取り境界が `partDecisions` を空配列へ正規化する。
   */
  getReview(reqId: string): Promise<Result<ReviewRequest>>;

  /**
   * review内のパーツ判定をまとめて変更する。
   *
   * 許す遷移は未判定 → 承認・却下、承認・却下 → 未判定だけ。1 件でも外れたら conflict で全部戻す。
   * 取り消しは `pending` を送り、返る判定の `status: 'pending'` は未判定と同義。
   *
   * 申請全体の状態が `pending` の場合だけ更新できる。`approved`または`rejected`の申請は
   * 既に処理済みとして`conflict`で拒否する。
   */
  updatePartDecisions(
    reqId: string,
    input: UpdateReviewPartDecisionsRequest,
  ): Promise<Result<ReviewPartDecision[]>>;

  /** 承認して実ファイルへ反映する(approver|admin のみ)。反映後メタ + 並行性警告を返す。 */
  approveReview(
    reqId: string,
    decision: ReviewDecisionRequest,
  ): Promise<Result<ApproveReviewResult>>;
  /** 却下する(approver|admin のみ)。理由は `decision.comment`(必須)。 */
  rejectReview(reqId: string, decision: ReviewDecisionRequest): Promise<Result<ReviewRequestMeta>>;
}
