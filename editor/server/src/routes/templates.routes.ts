import fs from 'node:fs/promises';
import path from 'node:path';
import { type DropdownQuery, notFound } from '@editor/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { config } from '../config.js';
import { actorFromReq, audit } from '../logger.js';
import { validate } from '../middleware/validate.js';
import { ConfirmSaveBody } from '../openapi/schemas.js';
import { dropdownOptions, filterTemplates, indexTemplates } from '../templates/fileIndex.js';

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

templatesRouter.get('/templates/options', async (req, res) => {
  const metas = await indexTemplates();
  res.json(dropdownOptions(metas, toQuery(req.query as Record<string, unknown>)));
});

templatesRouter.get('/templates', async (req, res) => {
  const metas = await indexTemplates();
  res.json(filterTemplates(metas, toQuery(req.query as Record<string, unknown>)));
});

templatesRouter.get('/templates/:id', async (req, res) => {
  const metas = await indexTemplates();
  const meta = metas.find((m) => m.id === req.params.id);
  if (!meta) {
    throw notFound('テンプレートが見つかりません');
  }
  const html = await fs
    .readFile(path.join(config.templatesDir, meta.fileName), 'utf8')
    .catch(() => '');
  const css = await fs
    .readFile(path.join(config.cssDir, `${meta.attributes.fundCode}.css`), 'utf8')
    .catch(() => '');
  res.json({ meta, html, css });
});

templatesRouter.put('/templates/:id', validate(ConfirmSaveBody), async (req, res) => {
  const body = req.body as z.infer<typeof ConfirmSaveBody>;
  const metas = await indexTemplates();
  const meta = metas.find((m) => m.id === req.params.id);
  const fileName = meta?.fileName ?? `${req.params.id}.html`;
  const resource = { id: req.params.id, fileName, fundCode: body.fundCode };
  try {
    await fs.mkdir(config.templatesDir, { recursive: true });
    await fs.mkdir(config.cssDir, { recursive: true });
    await fs.writeFile(path.join(config.templatesDir, fileName), body.html, 'utf8');
    await fs.writeFile(path.join(config.cssDir, `${body.fundCode}.css`), body.css, 'utf8');
    audit({ event: 'template.save', outcome: 'success', ...actorFromReq(req), resource });
    res.json({ ok: true, fileName });
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
