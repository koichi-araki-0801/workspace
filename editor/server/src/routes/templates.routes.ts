// =============================================================================
// templates.routes.ts — テンプレートのルート(phase 2)
// =============================================================================
// 候補(作成タブ)と生成登録は台帳 sproc、作成タブの会社・ファンド・シリーズは Rep1 を読む sproc、
// 一覧・候補(編集/比較/結合)・系列・作成済みの判定はファイル走査、本体(html/css)はファイルで扱う。
// 登録順が重要: `/templates/options` と `/templates/series` を `/templates/:id` より
// 先に登録し、id として捕捉されないようにする(Fastify は static>parametric を内部優先する
// ので機能上は順不同だが、可読性のため現行順を保つ)。
import {
  apiPaths,
  assertTemplateAttributeToken,
  DROPDOWN_SCOPES,
  type DropdownQuery,
  type DropdownScope,
  validation,
} from '@editor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { z } from 'zod';
import type { Deps } from '../deps.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate, validateQuery } from '../middleware/validate.js';
import { CreatableQuery, FundsQuery, SaveDraftRequest } from '../openapi/schemas.js';

function toQuery(q: Record<string, unknown>): DropdownQuery {
  const pick = (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined);
  return {
    companyCode: pick('companyCode'),
    fundCode: pick('fundCode'),
    baseDate: pick('baseDate'),
    editionType: pick('editionType'),
  };
}

/** `scope` の検査。省略・空文字は作成タブと同じ `create`(変更前の挙動)。 */
function toScope(v: unknown): DropdownScope {
  if (v === undefined || v === '') return 'create';
  if (typeof v === 'string' && (DROPDOWN_SCOPES as readonly string[]).includes(v)) {
    return v as DropdownScope;
  }
  throw validation(`scope は ${DROPDOWN_SCOPES.join(' / ')} のいずれかです`);
}

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

type IdParams = { Params: { id: string } };
type QueryRec = { Querystring: Record<string, unknown> };

export const templatesRoutes: FastifyPluginAsync<{
  deps: Pick<Deps, 'templates' | 'pairSync'>;
}> = async (app, opts) => {
  const { templates, pairSync } = opts.deps;

  app.get<QueryRec>(apiPaths.templatesOptions, { preHandler: requireAuth }, async (request) => {
    return templates.getDropdownOptions(toQuery(request.query), toScope(request.query.scope));
  });

  app.get(apiPaths.templatesCompanies, { preHandler: requireAuth }, async () =>
    templates.listCompanies(),
  );

  // Rep1 の会社コードは sproc のパラメータにしか使わない(ファイル名に入らない)ので、ファイル名の
  // トークン検査は掛けず、スキーマの長さだけを見る。
  app.get<{ Querystring: z.infer<typeof FundsQuery> }>(
    apiPaths.templatesFunds,
    { preHandler: [requireAuth, validateQuery(FundsQuery)] },
    async (request) => templates.listFunds(request.query.rep1CompanyCode),
  );

  app.get<{ Querystring: z.infer<typeof CreatableQuery> }>(
    apiPaths.templatesCreatable,
    { preHandler: [requireAuth, validateQuery(CreatableQuery)] },
    async (request) => {
      const q = request.query;
      return templates.getCreatableInfo({
        companyCode: assertTemplateAttributeToken('会社コード', q.companyCode),
        rep1CompanyCode: q.rep1CompanyCode,
        fundCode: assertTemplateAttributeToken('ファンドコード', q.fundCode),
        editionType: assertTemplateAttributeToken('版種', q.editionType),
      });
    },
  );

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

  // 保存先は URL の `:id` を正とする。body の `templateId` は互換のため受けるが、URL と
  // 食い違うものは拒否する — body 側だけを信じていた頃は、任意のパスへ HTML/CSS を書けた。
  app.put<{ Params: { id: string }; Body: z.infer<typeof SaveDraftRequest> }>(
    apiPaths.templateDraft,
    { preHandler: [requireAuth, requireEditor, validate(SaveDraftRequest)] },
    async (request, reply) => {
      const body = request.body;
      const templateId = request.params.id;
      if (body.templateId !== templateId) {
        throw validation('templateId が URL と一致しません');
      }
      await templates.saveDraft(templateId, body.html, body.css, actor(request));
      return reply.code(204).send();
    },
  );

  // 確定保存せずメニューへ戻った際の下書き破棄。冪等(無ければ no-op)なので 204 を返す。
  app.delete<IdParams>(
    apiPaths.templateDraft,
    { preHandler: [requireAuth, requireEditor] },
    async (request, reply) => {
      await templates.discardDraft(request.params.id);
      return reply.code(204).send();
    },
  );

  // 交付版⇄全体版 ペア同期の現況(編集画面を開いた時の競合バナー用)。
  app.get<IdParams>(apiPaths.templateSyncStatus, { preHandler: requireAuth }, async (request) => {
    return pairSync.getPairSyncStatus(request.params.id);
  });

  app.get<IdParams>(apiPaths.templateById, { preHandler: requireAuth }, async (request) => {
    return templates.getTemplate(request.params.id);
  });

  app.get<{ Params: { fundCode: string } }>(
    apiPaths.fundSampleData,
    { preHandler: requireAuth },
    async (request) => {
      return templates.getSampleData(request.params.fundCode);
    },
  );
};
