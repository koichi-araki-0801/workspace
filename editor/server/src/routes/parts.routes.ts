// =============================================================================
// parts.routes.ts — パーツカタログのルート(エディタ左ペイン)+ パーツ単位履歴
// =============================================================================
import type { PartClassificationQuery } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
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

export async function partsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/parts/classification-options', { preHandler: requireAuth }, async (request) => {
    return parts.getPartClassificationOptions(
      toClassQuery(request.query as Record<string, unknown>),
    );
  });

  app.get('/parts', { preHandler: requireAuth }, async (request) => {
    return parts.listParts(toClassQuery(request.query as Record<string, unknown>));
  });

  app.get('/templates/:templateId/part-history', { preHandler: requireAuth }, async (request) => {
    return history.listPartHistory(String((request.params as { templateId: string }).templateId));
  });

  app.post(
    '/templates/:templateId/part-history',
    { preHandler: [requireAuth, validate(RecordPartChangeRequest)] },
    async (request, reply) => {
      const body = request.body as z.infer<typeof RecordPartChangeRequest>;
      await history.recordPartChange(
        String((request.params as { templateId: string }).templateId),
        body.partKey,
        body.change,
        actor(request),
      );
      return reply.code(204).send();
    },
  );
}
