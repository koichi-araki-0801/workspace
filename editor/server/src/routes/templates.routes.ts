// =============================================================================
// templates.routes.ts — テンプレートのルート(phase 2)
// =============================================================================
// メタデータは台帳 sproc 経由、本体(html/css)はファイル経由で扱う。
// 登録順が重要: `/templates/options` と `/templates/series` を `/templates/:id` より
// 先に登録し、id として捕捉されないようにする。
import { type DropdownQuery, validation } from '@editor/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { auditedRethrow } from '../logger.js';
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
  const meta = await auditedRethrow(
    req,
    'template.save',
    () =>
      templates.confirmSave({
        templateId: String(req.params.id),
        html: body.html,
        css: body.css,
        fundCode: body.fundCode,
        loginId: actor(req),
      }),
    { success: () => ({ resource }), failure: () => ({ resource }), failureMessage: 'save failed' },
  );
  res.json(meta);
});

templatesRouter.get('/funds/:fundCode/sample-data', requireAuth, async (req, res) => {
  res.json(await templates.getSampleData(String(req.params.fundCode)));
});
