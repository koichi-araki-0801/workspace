import type {
  ConfirmSaveRequest,
  DropdownOptions,
  DropdownQuery,
  GenerateRequest,
  GenerateResult,
  SampleData,
  SaveDraftRequest,
  Template,
  TemplateDraft,
  TemplateMeta,
  TemplateRepository,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

const enc = encodeURIComponent;

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

  listSeriesFunds: (companyCode: string, fundCode: string, editionType: string) =>
    attemptRest(() =>
      apiFetch<TemplateMeta[]>('/templates/series', {
        query: { companyCode, fundCode, editionType },
      }),
    ),

  saveDraft: (req: SaveDraftRequest) =>
    attemptRest(() =>
      apiFetch<void>(`/templates/${enc(req.templateId)}/draft`, { method: 'PUT', body: req }),
    ),

  getDraft: (templateId: string) =>
    attemptRest(() => apiFetch<TemplateDraft | null>(`/templates/${enc(templateId)}/draft`)),

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
