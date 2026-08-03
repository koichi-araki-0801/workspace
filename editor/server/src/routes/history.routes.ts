// =============================================================================
// history.routes.ts — 履歴フィード / PDF 出力記録 / バージョン一覧 / スナップショット
// =============================================================================
import { apiPaths, isGitObjectId, validation } from '@editor/shared';
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

  // `:historyId` はそのまま `git show` のリビジョン引数になる。`-` 始まりの値を git は
  // オプションとして読む(`--output=<file>` で任意ファイルを破壊できる)ため、リポジトリ層へ
  // 渡す前に境界で弾く。同じ検査は `historyRepo`/`gitRepo` にも置く(多層防御)。
  app.get<{ Params: { historyId: string } }>(
    apiPaths.snapshotById,
    { preHandler: requireAuth },
    async (request) => {
      const { historyId } = request.params;
      if (!isGitObjectId(historyId)) throw validation(`版の指定が不正です: ${historyId}`);
      return history.getSnapshot(historyId);
    },
  );
}
