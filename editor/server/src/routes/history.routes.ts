// =============================================================================
// history.routes.ts — 履歴フィード / PDF 出力記録 / バージョン一覧 / スナップショット
// =============================================================================
import { apiPaths } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { RecordPdfExportRequest } from '../openapi/schemas.js';
import * as history from '../repositories/historyRepo.js';

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get(apiPaths.historyEdit, { preHandler: requireAuth }, async () => {
    return history.getEditHistory();
  });

  app.get(apiPaths.historyPdf, { preHandler: requireAuth }, async () => {
    return history.getPdfHistory();
  });

  app.post<{ Body: z.infer<typeof RecordPdfExportRequest> }>(
    apiPaths.historyPdf,
    { preHandler: [requireAuth, validate(RecordPdfExportRequest)] },
    async (request, reply) => {
      const body = request.body;
      await history.recordPdfExport(body.templateId, actor(request));
      return reply.code(204).send();
    },
  );

  app.get(apiPaths.historyCreate, { preHandler: requireAuth }, async () => {
    return history.getCreateHistory();
  });

  app.get<{ Params: { templateId: string } }>(
    apiPaths.templateVersions,
    { preHandler: requireAuth },
    async (request) => {
      return history.listVersions(request.params.templateId);
    },
  );

  app.get<{ Params: { historyId: string } }>(
    apiPaths.snapshotById,
    { preHandler: requireAuth },
    async (request) => {
      return history.getSnapshot(request.params.historyId);
    },
  );
}
