import fs from 'node:fs/promises';
import path from 'node:path';
import type { DropdownQuery } from '@editor/shared';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { actorFromReq, audit } from '../logger.js';
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
    res.status(404).json({ error: 'not found' });
    return;
  }
  const html = await fs
    .readFile(path.join(config.templatesDir, meta.fileName), 'utf8')
    .catch(() => '');
  const css = await fs
    .readFile(path.join(config.cssDir, `${meta.attributes.fundCode}.css`), 'utf8')
    .catch(() => '');
  res.json({ meta, html, css });
});

const saveSchema = z.object({ html: z.string(), css: z.string(), fundCode: z.string() });

templatesRouter.put('/templates/:id', async (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const metas = await indexTemplates();
  const meta = metas.find((m) => m.id === req.params.id);
  const fileName = meta?.fileName ?? `${req.params.id}.html`;
  const resource = { id: req.params.id, fileName, fundCode: parsed.data.fundCode };
  try {
    await fs.mkdir(config.templatesDir, { recursive: true });
    await fs.mkdir(config.cssDir, { recursive: true });
    await fs.writeFile(path.join(config.templatesDir, fileName), parsed.data.html, 'utf8');
    await fs.writeFile(
      path.join(config.cssDir, `${parsed.data.fundCode}.css`),
      parsed.data.css,
      'utf8',
    );
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
    res.status(500).json({ error: 'save failed' });
  }
});
