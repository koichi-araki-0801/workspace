/** Parts-catalog routes (editor left pane) + per-part history. */
import type { PartClassificationQuery } from '@editor/shared';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as history from '../repositories/historyRepo.js';
import * as parts from '../repositories/partRepo.js';

export const partsRouter = Router();

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
