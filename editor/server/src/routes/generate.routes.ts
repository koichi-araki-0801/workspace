// =============================================================================
// generate.routes.ts — 既存 Python ツールで新規テンプレートを生成
// =============================================================================
// REST モードでは生成結果をテンプレートファイルへ永続化し、台帳へ登録(status=draft)、
// 作成履歴フィードへ記録する。Python ステップ自体は変更しない。
import {
  type TemplateAttributes,
  type TemplateMeta,
  templateFileName,
  templateIdFromFileName,
} from '@editor/shared';
import type { FastifyInstance } from 'fastify';
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

export async function generateRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/generate',
    { preHandler: [requireAuth, validate(GenerateRequest)] },
    async (request) => {
      const body = request.body as z.infer<typeof GenerateRequest>;
      const loginId = request.user?.username ?? 'system';
      const { meta, html, css } = await auditedRethrow(
        request,
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

          // REST モード: ボディの永続化 + テンプレート登録 + 作成記録を行う。
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
      // 生成直後のスケルトンは静的な記入済み(filled)を持たない。エディタ側で描画する。
      return { template: { meta, html, css, filled: '' } };
    },
  );
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
