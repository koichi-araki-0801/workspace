// =============================================================================
// historyRepo.ts — 編集/PDF/作成履歴と版スナップショットの REST 実装
// =============================================================================
import type {
  CreateHistoryEntry,
  EditHistoryEntry,
  HistoryRepository,
  PdfHistoryEntry,
  TemplateSnapshot,
  TemplateVersionMeta,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

const enc = encodeURIComponent;

export const restHistoryRepo: HistoryRepository = {
  getEditHistory: () => attemptRest(() => apiFetch<EditHistoryEntry[]>('/history/edit')),
  getPdfHistory: () => attemptRest(() => apiFetch<PdfHistoryEntry[]>('/history/pdf')),
  getCreateHistory: () => attemptRest(() => apiFetch<CreateHistoryEntry[]>('/history/create')),

  recordPdfExport: (templateId: string) =>
    attemptRest(() => apiFetch<void>('/history/pdf', { method: 'POST', body: { templateId } })),

  listVersions: (templateId: string) =>
    attemptRest(() => apiFetch<TemplateVersionMeta[]>(`/templates/${enc(templateId)}/versions`)),

  getSnapshot: (historyId: string) =>
    attemptRest(() => apiFetch<TemplateSnapshot>(`/snapshots/${enc(historyId)}`)),
};
