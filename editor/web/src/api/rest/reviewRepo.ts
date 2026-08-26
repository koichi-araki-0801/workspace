// =============================================================================
// reviewRepo.ts — 確定保存の精査者承認ワークフローの REST 実装
// =============================================================================
import {
  type ApproveReviewResult,
  apiPaths,
  buildPath,
  type ReviewDecisionRequest,
  type ReviewListFilter,
  type ReviewRepository,
  type ReviewRequest,
  type ReviewRequestMeta,
  type SubmitReviewRequest,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restReviewRepo: ReviewRepository = {
  submitReview: (req: SubmitReviewRequest) =>
    attemptRest(() =>
      apiFetch<ReviewRequestMeta>(apiPaths.reviewRequests, { method: 'POST', body: req }),
    ),

  listReviews: (filter?: ReviewListFilter) =>
    attemptRest(() =>
      apiFetch<ReviewRequestMeta[]>(apiPaths.reviewRequests, {
        query: { status: filter?.status },
      }),
    ),

  getReview: (reqId: string) =>
    attemptRest(() => apiFetch<ReviewRequest>(buildPath(apiPaths.reviewRequestById, { reqId }))),

  approveReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attemptRest(() =>
      apiFetch<ApproveReviewResult>(buildPath(apiPaths.reviewRequestApprove, { reqId }), {
        method: 'POST',
        body: decision,
      }),
    ),

  rejectReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attemptRest(() =>
      apiFetch<ReviewRequestMeta>(buildPath(apiPaths.reviewRequestReject, { reqId }), {
        method: 'POST',
        body: decision,
      }),
    ),

  holdReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attemptRest(() =>
      apiFetch<ReviewRequestMeta>(buildPath(apiPaths.reviewRequestHold, { reqId }), {
        method: 'POST',
        body: decision,
      }),
    ),
};
