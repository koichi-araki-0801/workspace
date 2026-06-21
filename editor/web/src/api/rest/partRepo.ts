// =============================================================================
// partRepo.ts — パーツ分類候補/一覧/履歴の REST 実装
// =============================================================================
import type {
  PartCatalogItem,
  PartClassificationOptions,
  PartClassificationQuery,
  PartHistoryEntry,
  PartRepository,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

const enc = encodeURIComponent;

export const restPartRepo: PartRepository = {
  getPartClassificationOptions: (query: PartClassificationQuery) =>
    attemptRest(() =>
      apiFetch<PartClassificationOptions>('/parts/classification-options', {
        query: query as Record<string, string | undefined>,
      }),
    ),

  listParts: (query: PartClassificationQuery) =>
    attemptRest(() =>
      apiFetch<PartCatalogItem[]>('/parts', {
        query: query as Record<string, string | undefined>,
      }),
    ),

  getPartHistory: (templateId: string, partId: string) =>
    attemptRest(() =>
      apiFetch<PartHistoryEntry[]>(`/templates/${enc(templateId)}/parts/${enc(partId)}/history`),
    ),

  recordPartChange: (templateId: string, partId: string, change: string) =>
    attemptRest(() =>
      apiFetch<void>(`/templates/${enc(templateId)}/parts/${enc(partId)}/history`, {
        method: 'POST',
        body: { change },
      }),
    ),
};
