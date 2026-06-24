// =============================================================================
// templateRepo.ts — テンプレートの一覧/取得/生成/保存の REST 実装
// =============================================================================
import {
  type ConfirmSaveRequest,
  type DropdownOptions,
  type DropdownQuery,
  type FundResolution,
  type GenerateRequest,
  type GenerateResult,
  map,
  type SampleData,
  type SaveDraftRequest,
  type Template,
  type TemplateDraft,
  type TemplateMeta,
  type TemplateRepository,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

const enc = encodeURIComponent;

/** シリーズ(sproc `系列`)の問い合わせ。`resolveFund` と `listSeriesFunds` で共用。 */
const seriesFetch = (companyCode: string, fundCode: string, editionType: string) =>
  attemptRest(() =>
    apiFetch<TemplateMeta[]>('/templates/series', {
      query: { companyCode, fundCode, editionType },
    }),
  );

export const restTemplateRepo: TemplateRepository = {
  getDropdownOptions: (query: DropdownQuery) =>
    attemptRest(() =>
      apiFetch<DropdownOptions>('/templates/options', {
        query: query as Record<string, string | undefined>,
      }),
    ),

  listTemplates: (query: DropdownQuery) =>
    attemptRest(() =>
      apiFetch<TemplateMeta[]>('/templates', {
        query: query as Record<string, string | undefined>,
      }),
    ),

  getTemplate: (id: string) => attemptRest(() => apiFetch<Template>(`/templates/${enc(id)}`)),

  generate: (req: GenerateRequest) =>
    attemptRest(() => apiFetch<GenerateResult>('/generate', { method: 'POST', body: req })),

  // 属性解決: シリーズの sproc 結果に自分以外のメンバーが居ればシリーズファンド。
  resolveFund: async (companyCode: string, fundCode: string, editionType: string) =>
    map(
      await seriesFetch(companyCode, fundCode, editionType),
      (rows): FundResolution => ({
        isSeriesFund: rows.some((m) => m.attributes.fundCode !== fundCode),
      }),
    ),

  listSeriesFunds: (companyCode: string, fundCode: string, editionType: string) =>
    seriesFetch(companyCode, fundCode, editionType),

  saveDraft: (req: SaveDraftRequest) =>
    attemptRest(() =>
      apiFetch<void>(`/templates/${enc(req.templateId)}/draft`, { method: 'PUT', body: req }),
    ),

  getDraft: (templateId: string) =>
    attemptRest(() => apiFetch<TemplateDraft | null>(`/templates/${enc(templateId)}/draft`)),

  discardDraft: (templateId: string) =>
    attemptRest(() => apiFetch<void>(`/templates/${enc(templateId)}/draft`, { method: 'DELETE' })),

  confirmSave: (req: ConfirmSaveRequest) =>
    attemptRest(() =>
      apiFetch<TemplateMeta>(`/templates/${enc(req.templateId)}`, {
        method: 'PUT',
        body: { html: req.html, css: req.css, fundCode: req.fundCode },
      }),
    ),

  getSampleData: (fundCode: string) =>
    attemptRest(() => apiFetch<SampleData>(`/funds/${enc(fundCode)}/sample-data`)),
};
