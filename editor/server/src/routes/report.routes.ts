// =============================================================================
// report.routes.ts — create_report 連携の 4 ルート
// =============================================================================
// 状態と一覧は閲覧者にも開き、生成と PDF は編集者以上。処理は `deps.report` に任せる。
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
    { preHandler: [requireAuth, requireEditor, validate(ReportPdfRequest)] },
    async (request, reply) => {
      const { id } = request.params;
      const pdf = await auditedRethrow(
        request,
        'report.pdf',
        () => report.buildPdf(id, request.body.html),
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
