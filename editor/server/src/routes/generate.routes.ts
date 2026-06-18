/**
 * Generate a new template via the existing Python tool. In REST mode the result
 * is persisted to the template file, registered in the 台帳 (status=draft), and
 * recorded in the create-history feed. The Python step is unchanged.
 */
import {
  type TemplateAttributes,
  type TemplateMeta,
  templateFileName,
  templateIdFromFileName,
} from '@editor/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { config } from '../config.js';
import { readFundCss, writeTemplateAndCss } from '../files/templateFiles.js';
import { generateTemplate } from '../generate/pyTemplate.js';
import { auditedRethrow } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { GenerateRequest } from '../openapi/schemas.js';
import { recordCreate } from '../repositories/historyRepo.js';
import { registerGenerated } from '../repositories/templateRepo.js';

export const generateRouter = Router();

generateRouter.post('/generate', requireAuth, validate(GenerateRequest), async (req, res) => {
  const body = req.body as z.infer<typeof GenerateRequest>;
  const loginId = req.user?.username ?? 'system';
  const { meta, html, css } = await auditedRethrow(
    req,
    'template.generate',
    async () => {
      const html = await generateTemplate(body);
      const attributes: TemplateAttributes = {
        companyCode: body.companyCode,
        fundCode: body.fundCode,
        baseDate: todayYmd(),
        editionType: body.editionType,
      };
      const fileName = templateFileName(attributes);
      const id = templateIdFromFileName(fileName);
      const css = await readFundCss(attributes.fundCode);
      const meta: TemplateMeta = {
        id,
        attributes,
        fileName,
        status: 'draft',
        updatedAt: null,
        updatedBy: null,
      };

      // REST mode: persist the body + register the template + record creation.
      if (config.requireAuth) {
        await writeTemplateAndCss(fileName, html, attributes.fundCode, css);
        await registerGenerated(attributes, id);
        await recordCreate(attributes, body.basedOnTemplateId, loginId);
      }

      return { meta, html, css, id, attributes };
    },
    {
      success: (r) => ({ resource: { id: r.id, ...r.attributes } }),
      failure: () => ({
        resource: {
          companyCode: body.companyCode,
          fundCode: body.fundCode,
          editionType: body.editionType,
        },
      }),
      failureMessage: 'generation failed',
    },
  );
  // A freshly generated skeleton has no static fill; the editor renders one.
  res.json({ template: { meta, html, css, filled: '' } });
});

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
