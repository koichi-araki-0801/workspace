// =============================================================================
// historyRepo.ts — 編集/PDF/作成履歴と版スナップショットの REST 実装
// =============================================================================
import {
  apiPaths,
  buildPath,
  type CreateHistoryEntry,
  type EditHistoryEntry,
  type HistoryRepository,
  type PdfHistoryEntry,
  type TemplateSnapshot,
  type TemplateVersionMeta,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restHistoryRepo: HistoryRepository = {
  getEditHistory: () => attemptRest(() => apiFetch<EditHistoryEntry[]>(apiPaths.historyEdit)),
  getPdfHistory: () => attemptRest(() => apiFetch<PdfHistoryEntry[]>(apiPaths.historyPdf)),
  getCreateHistory: () => attemptRest(() => apiFetch<CreateHistoryEntry[]>(apiPaths.historyCreate)),

  recordPdfExport: (templateId: string) =>
    attemptRest(() =>
      apiFetch<void>(apiPaths.historyPdf, { method: 'POST', body: { templateId } }),
    ),

  listVersions: (templateId: string) =>
    attemptRest(() =>
      apiFetch<TemplateVersionMeta[]>(buildPath(apiPaths.templateVersions, { templateId })),
    ),

  getSnapshot: (historyId: string) =>
    attemptRest(() => apiFetch<TemplateSnapshot>(buildPath(apiPaths.snapshotById, { historyId }))),
};
