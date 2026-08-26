// =============================================================================
// reviews.routes.ts — 確定保存の精査者承認ワークフローのルート
// =============================================================================
// 申請(submit)は誰でも(認証済み)積めるが実ファイルは更新しない。承認(approve)/却下
// (reject)は `requireApprover` で施錠し、approve だけが実ファイル + git へ反映する
// (`reviewRepo.ts`)。承認/却下は監査イベント(`review.approve` / `review.reject`)を記録する。
import { apiPaths } from '@editor/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { auditedRethrow } from '../logger.js';
import { requireApprover, requireAuth, requireEditor } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { ReviewDecisionBody, ReviewListQuery, SubmitReviewBody } from '../openapi/schemas.js';
import * as reviews from '../repositories/reviewRepo.js';

/** 操作主体を request.user から導く。local モード(user 未設定)は全件可視の system 扱い。 */
function actor(req: FastifyRequest): reviews.ReviewActor {
  return { username: req.user?.username ?? 'system', role: req.user?.role ?? 'admin' };
}

// `:reqId` を持つルートで共有する params 型(RouteGeneric に渡してキャストを消す)。
type ReqIdParams = { Params: { reqId: string } };

export async function reviewsRoutes(app: FastifyInstance): Promise<void> {
  // 申請を作成(pending)。実ファイルは更新しない。
  app.post<{ Body: z.infer<typeof SubmitReviewBody> }>(
    apiPaths.reviewRequests,
    { preHandler: [requireAuth, requireEditor, validate(SubmitReviewBody)] },
    async (request) => {
      const body = request.body;
      return auditedRethrow(
        request,
        'review.submit',
        () => reviews.submitReview(body, actor(request)),
        {
          success: (meta) => ({ resource: { id: meta.id, templateId: meta.templateId } }),
          failure: () => ({ resource: { templateId: body.templateId } }),
          failureMessage: 'submit failed',
        },
      );
    },
  );

  // 承認キュー一覧。approver|admin は全件、editor は自分の申請のみ(`reviewRepo` が絞る)。
  // status は `validateQuery` で検証済み(不正値は 400)。
  app.get<{ Querystring: z.infer<typeof ReviewListQuery> }>(
    apiPaths.reviewRequests,
    { preHandler: [requireAuth, validateQuery(ReviewListQuery)] },
    async (request) => {
      const { status } = request.query;
      return reviews.listReviews({ status }, actor(request));
    },
  );

  // 申請詳細(本体込み・プレビュー用)。閲覧範囲は一覧と対称(本人 or approver|admin)。
  app.get<ReqIdParams>(apiPaths.reviewRequestById, { preHandler: requireAuth }, async (request) => {
    return reviews.getReview(request.params.reqId, actor(request));
  });

  // 承認 → 実ファイル反映 + git commit(精査者限定)。
  app.post<ReqIdParams & { Body: z.infer<typeof ReviewDecisionBody> }>(
    apiPaths.reviewRequestApprove,
    { preHandler: [requireAuth, requireApprover, validate(ReviewDecisionBody)] },
    async (request) => {
      const reqId = request.params.reqId;
      return auditedRethrow(
        request,
        'review.approve',
        () => reviews.approveReview(reqId, request.body, actor(request)),
        {
          success: (result) => ({ resource: { reqId, templateId: result.meta.id } }),
          failure: () => ({ resource: { reqId } }),
          failureMessage: 'approve failed',
        },
      );
    },
  );

  // 却下(精査者限定)。実ファイルは更新しない。
  app.post<ReqIdParams & { Body: z.infer<typeof ReviewDecisionBody> }>(
    apiPaths.reviewRequestReject,
    { preHandler: [requireAuth, requireApprover, validate(ReviewDecisionBody)] },
    async (request) => {
      const reqId = request.params.reqId;
      return auditedRethrow(
        request,
        'review.reject',
        () => reviews.rejectReview(reqId, request.body, actor(request)),
        {
          success: (meta) => ({ resource: { reqId, templateId: meta.templateId } }),
          failure: () => ({ resource: { reqId } }),
          failureMessage: 'reject failed',
        },
      );
    },
  );

  // 保留(精査者限定)。実ファイルは更新しない。判断を保留して後で戻るための状態遷移。
  app.post<ReqIdParams & { Body: z.infer<typeof ReviewDecisionBody> }>(
    apiPaths.reviewRequestHold,
    { preHandler: [requireAuth, requireApprover, validate(ReviewDecisionBody)] },
    async (request) => {
      const reqId = request.params.reqId;
      return auditedRethrow(
        request,
        'review.hold',
        () => reviews.holdReview(reqId, request.body, actor(request)),
        {
          success: (meta) => ({ resource: { reqId, templateId: meta.templateId } }),
          failure: () => ({ resource: { reqId } }),
          failureMessage: 'hold failed',
        },
      );
    },
  );
}
