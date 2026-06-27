// =============================================================================
// templates.routes.ts — テンプレートのルート(phase 2)
// =============================================================================
// メタデータは台帳 sproc 経由、本体(html/css)はファイル経由で扱う。
// 登録順が重要: `/templates/options` と `/templates/series` を `/templates/:id` より
// 先に登録し、id として捕捉されないようにする(Fastify は static>parametric を内部優先する
// ので機能上は順不同だが、可読性のため現行順を保つ)。
import { type DropdownQuery, validation } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { auditedRethrow } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ConfirmSaveBody, SaveDraftRequest } from '../openapi/schemas.js';
import * as templates from '../repositories/templateRepo.js';

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

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/templates/options', { preHandler: requireAuth }, async (request) => {
    return templates.getDropdownOptions(toQuery(request.query as Record<string, unknown>));
  });

  app.get('/templates/series', { preHandler: requireAuth }, async (request) => {
    const q = request.query as Record<string, unknown>;
    const companyCode = typeof q.companyCode === 'string' ? q.companyCode : '';
    const editionType = typeof q.editionType === 'string' ? q.editionType : '';
    if (!companyCode || !editionType) throw validation('companyCode と editionType が必要です');
    return templates.listSeriesFunds(companyCode, editionType);
  });

  app.get('/templates', { preHandler: requireAuth }, async (request) => {
    return templates.listTemplates(toQuery(request.query as Record<string, unknown>));
  });

  app.get('/templates/:id/draft', { preHandler: requireAuth }, async (request) => {
    return templates.getDraft(String((request.params as { id: string }).id));
  });

  app.put(
    '/templates/:id/draft',
    { preHandler: [requireAuth, validate(SaveDraftRequest)] },
    async (request, reply) => {
      const body = request.body as z.infer<typeof SaveDraftRequest>;
      await templates.saveDraft(body.templateId, body.html, body.css, actor(request));
      return reply.code(204).send();
    },
  );

  // 確定保存せずメニューへ戻った際の下書き破棄。冪等(無ければ no-op)なので 204 を返す。
  app.delete('/templates/:id/draft', { preHandler: requireAuth }, async (request, reply) => {
    await templates.discardDraft(String((request.params as { id: string }).id));
    return reply.code(204).send();
  });

  app.get('/templates/:id', { preHandler: requireAuth }, async (request) => {
    return templates.getTemplate(String((request.params as { id: string }).id));
  });

  app.put(
    '/templates/:id',
    { preHandler: [requireAuth, validate(ConfirmSaveBody)] },
    async (request) => {
      const id = String((request.params as { id: string }).id);
      const body = request.body as z.infer<typeof ConfirmSaveBody>;
      const resource = { id, fundCode: body.fundCode };
      return auditedRethrow(
        request,
        'template.save',
        () =>
          templates.confirmSave({
            templateId: id,
            html: body.html,
            css: body.css,
            fundCode: body.fundCode,
            loginId: actor(request),
          }),
        {
          success: () => ({ resource }),
          failure: () => ({ resource }),
          failureMessage: 'save failed',
        },
      );
    },
  );

  app.get('/funds/:fundCode/sample-data', { preHandler: requireAuth }, async (request) => {
    return templates.getSampleData(String((request.params as { fundCode: string }).fundCode));
  });
}
