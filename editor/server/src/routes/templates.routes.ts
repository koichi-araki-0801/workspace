/**
 * Template routes (phase 2): metadata via the 台帳 sproc, bodies via files.
 * Order matters — `/templates/options` and `/templates/series` are registered
 * before `/templates/:id` so they aren't captured as an id.
 */
import { type DropdownQuery, validation } from '@editor/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { actorFromReq, audit } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ConfirmSaveBody, SaveDraftRequest } from '../openapi/schemas.js';
import * as templates from '../repositories/templateRepo.js';

export const templatesRouter = Router();

function toQuery(q: Record<string, unknown>): DropdownQuery {
  const pick = (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined);
  return {
    companyCode: pick('companyCode'),
    fundCode: pick('fundCode'),
    baseDate: pick('baseDate'),
    editionType: pick('editionType'),
  };
}

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

templatesRouter.get('/templates/options', requireAuth, async (req, res) => {
  res.json(await templates.getDropdownOptions(toQuery(req.query as Record<string, unknown>)));
});

templatesRouter.get('/templates/series', requireAuth, async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const companyCode = typeof q.companyCode === 'string' ? q.companyCode : '';
  const editionType = typeof q.editionType === 'string' ? q.editionType : '';
  if (!companyCode || !editionType) throw validation('companyCode と editionType が必要です');
  res.json(await templates.listSeriesFunds(companyCode, editionType));
});

templatesRouter.get('/templates', requireAuth, async (req, res) => {
  res.json(await templates.listTemplates(toQuery(req.query as Record<string, unknown>)));
});

templatesRouter.get('/templates/:id/draft', requireAuth, async (req, res) => {
  res.json(await templates.getDraft(String(req.params.id)));
});

templatesRouter.put(
  '/templates/:id/draft',
  requireAuth,
  validate(SaveDraftRequest),
  async (req, res) => {
    const body = req.body as z.infer<typeof SaveDraftRequest>;
    await templates.saveDraft(body.templateId, body.html, body.css, actor(req));
    res.status(204).end();
  },
);

templatesRouter.get('/templates/:id', requireAuth, async (req, res) => {
  res.json(await templates.getTemplate(String(req.params.id)));
});

templatesRouter.put('/templates/:id', requireAuth, validate(ConfirmSaveBody), async (req, res) => {
  const body = req.body as z.infer<typeof ConfirmSaveBody>;
  const resource = { id: String(req.params.id), fundCode: body.fundCode };
  try {
    const meta = await templates.confirmSave({
      templateId: String(req.params.id),
      html: body.html,
      css: body.css,
      fundCode: body.fundCode,
      loginId: actor(req),
    });
    audit({ event: 'template.save', outcome: 'success', ...actorFromReq(req), resource });
    res.json(meta);
  } catch (e) {
    audit({
      event: 'template.save',
      outcome: 'failure',
      ...actorFromReq(req),
      resource,
      error: e instanceof Error ? e.message : 'save failed',
    });
    throw e;
  }
});

templatesRouter.get('/funds/:fundCode/sample-data', requireAuth, async (req, res) => {
  res.json(await templates.getSampleData(String(req.params.fundCode)));
});
