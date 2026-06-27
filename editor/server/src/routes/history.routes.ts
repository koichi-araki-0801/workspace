// =============================================================================
// history.routes.ts — 履歴フィード / PDF 出力記録 / バージョン一覧 / スナップショット
// =============================================================================
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { RecordPdfExportRequest } from '../openapi/schemas.js';
import * as history from '../repositories/historyRepo.js';

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/history/edit', { preHandler: requireAuth }, async () => {
    return history.getEditHistory();
  });

  app.get('/history/pdf', { preHandler: requireAuth }, async () => {
    return history.getPdfHistory();
  });

  app.post(
    '/history/pdf',
    { preHandler: [requireAuth, validate(RecordPdfExportRequest)] },
    async (request, reply) => {
      const body = request.body as z.infer<typeof RecordPdfExportRequest>;
      await history.recordPdfExport(body.templateId, actor(request));
      return reply.code(204).send();
    },
  );

  app.get('/history/create', { preHandler: requireAuth }, async () => {
    return history.getCreateHistory();
  });

  app.get('/templates/:templateId/versions', { preHandler: requireAuth }, async (request) => {
    return history.listVersions(String((request.params as { templateId: string }).templateId));
  });

  app.get('/snapshots/:historyId', { preHandler: requireAuth }, async (request) => {
    return history.getSnapshot(String((request.params as { historyId: string }).historyId));
  });
}
