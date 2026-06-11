import fs from 'node:fs/promises';
import path from 'node:path';
import { type TemplateMeta, templateFileName, templateIdFromFileName } from '@editor/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { config } from '../config.js';
import { generateTemplate } from '../generate/pyTemplate.js';
import { actorFromReq, audit } from '../logger.js';
import { validate } from '../middleware/validate.js';
import { GenerateRequest } from '../openapi/schemas.js';

export const generateRouter = Router();

generateRouter.post('/generate', validate(GenerateRequest), async (req, res) => {
  const body = req.body as z.infer<typeof GenerateRequest>;
  try {
    const html = await generateTemplate(body);
    const baseDate = todayYmd();
    const attributes = {
      companyCode: body.companyCode,
      fundCode: body.fundCode,
      baseDate,
      editionType: body.editionType,
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
        companyCode: body.companyCode,
        fundCode: body.fundCode,
        editionType: body.editionType,
      },
      error: e instanceof Error ? e.message : 'generation failed',
    });
    throw e;
  }
});

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
