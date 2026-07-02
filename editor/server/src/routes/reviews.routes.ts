// =============================================================================
// reviews.routes.ts — 確定保存の精査者承認ワークフローのルート
// =============================================================================
// 申請(submit)は誰でも(認証済み)積めるが実ファイルは更新しない。承認(approve)/却下
// (reject)は `requireApprover` で施錠し、approve だけが実ファイル + git へ反映する
// (`reviewRepo.ts`)。承認/却下は監査イベント(`review.approve` / `review.reject`)を記録する。
import { apiPaths, type ReviewStatus } from '@editor/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { auditedRethrow } from '../logger.js';
import { requireApprover, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ReviewDecisionBody, SubmitReviewBody } from '../openapi/schemas.js';
import * as reviews from '../repositories/reviewRepo.js';

/** 操作主体を request.user から導く。local モード(user 未設定)は全件可視の system 扱い。 */
function actor(req: FastifyRequest): reviews.ReviewActor {
  return { username: req.user?.username ?? 'system', role: req.user?.role ?? 'admin' };
}

const reqIdOf = (req: FastifyRequest): string => String((req.params as { reqId: string }).reqId);
const decisionOf = (req: FastifyRequest) => req.body as z.infer<typeof ReviewDecisionBody>;

export async function reviewsRoutes(app: FastifyInstance): Promise<void> {
  // 申請を作成(pending)。実ファイルは更新しない。
  app.post(
    apiPaths.reviewRequests,
    { preHandler: [requireAuth, validate(SubmitReviewBody)] },
    async (request) => {
      const body = request.body as z.infer<typeof SubmitReviewBody>;
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
  app.get(apiPaths.reviewRequests, { preHandler: requireAuth }, async (request) => {
    const q = request.query as Record<string, unknown>;
    const status = typeof q.status === 'string' ? (q.status as ReviewStatus) : undefined;
    return reviews.listReviews({ status }, actor(request));
  });

  // 申請詳細(本体込み・プレビュー用)。閲覧範囲は一覧と対称(本人 or approver|admin)。
  app.get(apiPaths.reviewRequestById, { preHandler: requireAuth }, async (request) => {
    return reviews.getReview(reqIdOf(request), actor(request));
  });

  // 承認 → 実ファイル反映 + git commit(精査者限定)。
  app.post(
    apiPaths.reviewRequestApprove,
    { preHandler: [requireAuth, requireApprover, validate(ReviewDecisionBody)] },
    async (request) => {
      const reqId = reqIdOf(request);
      return auditedRethrow(
        request,
        'review.approve',
        () => reviews.approveReview(reqId, decisionOf(request), actor(request)),
        {
          success: (meta) => ({ resource: { reqId, templateId: meta.id } }),
          failure: () => ({ resource: { reqId } }),
          failureMessage: 'approve failed',
        },
      );
    },
  );

  // 却下(精査者限定)。実ファイルは更新しない。
  app.post(
    apiPaths.reviewRequestReject,
    { preHandler: [requireAuth, requireApprover, validate(ReviewDecisionBody)] },
    async (request) => {
      const reqId = reqIdOf(request);
      return auditedRethrow(
        request,
        'review.reject',
        () => reviews.rejectReview(reqId, decisionOf(request), actor(request)),
        {
          success: (meta) => ({ resource: { reqId, templateId: meta.templateId } }),
          failure: () => ({ resource: { reqId } }),
          failureMessage: 'reject failed',
        },
      );
    },
  );
}
