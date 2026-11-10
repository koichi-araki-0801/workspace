// =============================================================================
// report.routes.ts — create_report 連携の 4 ルート
// =============================================================================
// 状態・一覧・単体 PDF は閲覧者にも開き、値入り HTML の生成は編集者以上。処理は `deps.report` に任せる。
// 単体 PDF は `/api/build` と同じ閲覧業務としての出力で、入出力は応答後に消えサーバに状態を残さない。
import { apiPaths, type FillResult, type ReportSkeletons, type ReportStatus } from '@editor/shared';
import { ReportPdfRequest } from '@editor/shared/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import type { Deps } from '../deps.js';
import { auditedRethrow } from '../logger.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { actorOf } from './routeHelpers.js';

export const reportRoutes: FastifyPluginAsync<{ deps: Pick<Deps, 'report'> }> = async (
  app,
  opts,
) => {
  const { report } = opts.deps;

  app.get(apiPaths.reportStatus, { preHandler: [requireAuth] }, async (): Promise<ReportStatus> => {
    return report.status();
  });

  app.get(
    apiPaths.reportSkeletons,
    { preHandler: [requireAuth] },
    async (): Promise<ReportSkeletons> => ({ skeletons: await report.listSkeletons() }),
  );

  app.post<{ Params: { id: string } }>(
    apiPaths.templateFill,
    { preHandler: [requireAuth, requireEditor] },
    async (request): Promise<FillResult> => {
      const { id } = request.params;
      return auditedRethrow(request, 'report.fill', () => report.fill(id, actorOf(request)), {
        success: (r) => ({ resource: { templateId: id }, detail: { created: r.created } }),
        failure: () => ({ resource: { templateId: id } }),
        failureMessage: 'create_report fill failed',
      });
    },
  );

  app.post<{ Params: { id: string }; Body: z.infer<typeof ReportPdfRequest> }>(
    apiPaths.templateReportPdf,
    { preHandler: [requireAuth, validate(ReportPdfRequest)] },
    async (request, reply) => {
      const { id } = request.params;
      const pdf = await auditedRethrow(
        request,
        'report.pdf',
        () => report.buildPdf(id, request.body.html, actorOf(request)),
        {
          success: (p) => ({ resource: { templateId: id }, detail: { pdfBytes: p.length } }),
          failure: () => ({ resource: { templateId: id } }),
          failureMessage: 'create_report pdf failed',
        },
      );
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'attachment; filename="report.pdf"')
        .send(pdf);
    },
  );
};
