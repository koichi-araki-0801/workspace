// =============================================================================
// templates.routes.ts — テンプレートのルート(phase 2)
// =============================================================================
// メタデータは台帳 sproc 経由、本体(html/css)はファイル経由で扱う。
// 登録順が重要: `/templates/options` と `/templates/series` を `/templates/:id` より
// 先に登録し、id として捕捉されないようにする(Fastify は static>parametric を内部優先する
// ので機能上は順不同だが、可読性のため現行順を保つ)。
import { apiPaths, type DropdownQuery, validation } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { auditedRethrow } from '../logger.js';
import { requireApprover, requireAuth } from '../middleware/auth.js';
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

type IdParams = { Params: { id: string } };
type QueryRec = { Querystring: Record<string, unknown> };

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  app.get<QueryRec>(apiPaths.templatesOptions, { preHandler: requireAuth }, async (request) => {
    return templates.getDropdownOptions(toQuery(request.query));
  });

  app.get<QueryRec>(apiPaths.templatesSeries, { preHandler: requireAuth }, async (request) => {
    const q = request.query;
    const companyCode = typeof q.companyCode === 'string' ? q.companyCode : '';
    const editionType = typeof q.editionType === 'string' ? q.editionType : '';
    if (!companyCode || !editionType) throw validation('companyCode と editionType が必要です');
    return templates.listSeriesFunds(companyCode, editionType);
  });

  app.get<QueryRec>(apiPaths.templates, { preHandler: requireAuth }, async (request) => {
    return templates.listTemplates(toQuery(request.query));
  });

  app.get<IdParams>(apiPaths.templateDraft, { preHandler: requireAuth }, async (request) => {
    return templates.getDraft(request.params.id);
  });

  app.put<{ Body: z.infer<typeof SaveDraftRequest> }>(
    apiPaths.templateDraft,
    { preHandler: [requireAuth, validate(SaveDraftRequest)] },
    async (request, reply) => {
      const body = request.body;
      await templates.saveDraft(body.templateId, body.html, body.css, actor(request));
      return reply.code(204).send();
    },
  );

  // 確定保存せずメニューへ戻った際の下書き破棄。冪等(無ければ no-op)なので 204 を返す。
  app.delete<IdParams>(
    apiPaths.templateDraft,
    { preHandler: requireAuth },
    async (request, reply) => {
      await templates.discardDraft(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<IdParams>(apiPaths.templateById, { preHandler: requireAuth }, async (request) => {
    return templates.getTemplate(request.params.id);
  });

  // 直接の確定保存は精査者(承認者)限定の緊急経路。通常の確定保存は承認ワークフロー
  // (POST /review-requests → approve)を使い、編集者は実ファイルへ直接書けない。
  app.put<IdParams & { Body: z.infer<typeof ConfirmSaveBody> }>(
    apiPaths.templateById,
    { preHandler: [requireAuth, requireApprover, validate(ConfirmSaveBody)] },
    async (request) => {
      const id = request.params.id;
      const body = request.body;
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

  app.get<{ Params: { fundCode: string } }>(
    apiPaths.fundSampleData,
    { preHandler: requireAuth },
    async (request) => {
      return templates.getSampleData(request.params.fundCode);
    },
  );
}
