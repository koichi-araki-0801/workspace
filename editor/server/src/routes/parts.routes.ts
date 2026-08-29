// =============================================================================
// parts.routes.ts — パーツカタログのルート(エディタ左ペイン)+ パーツ単位履歴
// =============================================================================
import { apiPaths, type PartClassificationQuery } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { RecordPartChangeRequest } from '../openapi/schemas.js';
import * as history from '../repositories/historyRepo.js';
import * as parts from '../repositories/partRepo.js';

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

function toClassQuery(q: Record<string, unknown>): PartClassificationQuery {
  const pick = (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined);
  return {
    category: pick('category'),
    majorClass: pick('majorClass'),
    middleClass: pick('middleClass'),
    minorClass: pick('minorClass'),
  };
}

type ClassQuery = { Querystring: Record<string, unknown> };
type PartHistoryParams = { Params: { templateId: string } };

export async function partsRoutes(app: FastifyInstance): Promise<void> {
  app.get<ClassQuery>(
    apiPaths.partClassificationOptions,
    { preHandler: requireAuth },
    async (request) => {
      return parts.getPartClassificationOptions(toClassQuery(request.query));
    },
  );

  app.get<ClassQuery>(apiPaths.parts, { preHandler: requireAuth }, async (request) => {
    return parts.listParts(toClassQuery(request.query));
  });

  app.get<PartHistoryParams>(apiPaths.partHistory, { preHandler: requireAuth }, async (request) => {
    return history.listPartHistory(request.params.templateId);
  });

  app.post<PartHistoryParams & { Body: z.infer<typeof RecordPartChangeRequest> }>(
    apiPaths.partHistory,
    { preHandler: [requireAuth, requireEditor, validate(RecordPartChangeRequest)] },
    async (request, reply) => {
      const body = request.body;
      await history.recordPartChange(
        request.params.templateId,
        body.partKey,
        body.change,
        actor(request),
      );
      return reply.code(204).send();
    },
  );
}
