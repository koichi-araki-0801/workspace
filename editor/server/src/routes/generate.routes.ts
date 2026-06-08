import fs from 'node:fs/promises';
import path from 'node:path';
import { type TemplateMeta, templateFileName, templateIdFromFileName } from '@editor/shared';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { generateTemplate } from '../generate/pyTemplate.js';
import { actorFromReq, audit } from '../logger.js';

export const generateRouter = Router();

const schema = z.object({
  companyCode: z.string().min(1),
  fundCode: z.string().min(1),
  editionType: z.string().min(1),
  basedOnTemplateId: z.string().optional(),
});

generateRouter.post('/generate', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  try {
    const html = await generateTemplate(parsed.data);
    const baseDate = todayYmd();
    const attributes = {
      companyCode: parsed.data.companyCode,
      fundCode: parsed.data.fundCode,
      baseDate,
      editionType: parsed.data.editionType,
    };
    const fileName = templateFileName(attributes);
    const id = templateIdFromFileName(fileName);
    const meta: TemplateMeta = {
      id,
      attributes,
      fileName,
      status: 'draft',
      updatedAt: null,
      updatedBy: null,
    };

    const css = await fs
      .readFile(path.join(config.cssDir, `${attributes.fundCode}.css`), 'utf8')
      .catch(() => '');

    audit({
      event: 'template.generate',
      outcome: 'success',
      ...actorFromReq(req),
      resource: { id, ...attributes },
    });
    res.json({ template: { meta, html, css } });
  } catch (e) {
    audit({
      event: 'template.generate',
      outcome: 'failure',
      ...actorFromReq(req),
      resource: {
        companyCode: parsed.data.companyCode,
        fundCode: parsed.data.fundCode,
        editionType: parsed.data.editionType,
      },
      error: e instanceof Error ? e.message : 'generation failed',
    });
    res.status(500).json({ error: e instanceof Error ? e.message : 'generation failed' });
  }
});

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
