// =============================================================================
// parts.routes.ts — パーツカタログのルート(エディタ左ペイン)+ パーツ単位履歴
// =============================================================================
import type { PartClassificationQuery } from '@editor/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { RecordPartChangeRequest } from '../openapi/schemas.js';
import * as history from '../repositories/historyRepo.js';
import * as parts from '../repositories/partRepo.js';

export const partsRouter = Router();

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

partsRouter.get('/parts/classification-options', requireAuth, async (req, res) => {
  res.json(
    await parts.getPartClassificationOptions(toClassQuery(req.query as Record<string, unknown>)),
  );
});

partsRouter.get('/parts', requireAuth, async (req, res) => {
  res.json(await parts.listParts(toClassQuery(req.query as Record<string, unknown>)));
});

partsRouter.get('/templates/:templateId/parts/:partId/history', requireAuth, async (req, res) => {
  res.json(await history.getPartHistory(String(req.params.templateId), String(req.params.partId)));
});

partsRouter.post(
  '/templates/:templateId/parts/:partId/history',
  requireAuth,
  validate(RecordPartChangeRequest),
  async (req, res) => {
    const body = req.body as z.infer<typeof RecordPartChangeRequest>;
    await history.recordPartChange(
      String(req.params.templateId),
      String(req.params.partId),
      body.change,
      actor(req),
    );
    res.status(204).end();
  },
);
