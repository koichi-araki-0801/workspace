// =============================================================================
// partRepo.ts — パーツ分類候補/一覧/履歴の REST 実装
// =============================================================================
import {
  apiPaths,
  buildPath,
  type PartCatalogItem,
  type PartClassificationOptions,
  type PartClassificationQuery,
  type PartHistoryEntry,
  type PartRepository,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restPartRepo: PartRepository = {
  getPartClassificationOptions: (query: PartClassificationQuery) =>
    attemptRest(() =>
      apiFetch<PartClassificationOptions>(apiPaths.partClassificationOptions, {
        query: query as Record<string, string | undefined>,
      }),
    ),

  listParts: (query: PartClassificationQuery) =>
    attemptRest(() =>
      apiFetch<PartCatalogItem[]>(apiPaths.parts, {
        query: query as Record<string, string | undefined>,
      }),
    ),

  listPartHistory: (templateId: string) =>
    attemptRest(() =>
      apiFetch<PartHistoryEntry[]>(buildPath(apiPaths.partHistory, { templateId })),
    ),

  recordPartChange: (templateId: string, partKey: string, change: string) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.partHistory, { templateId }), {
        method: 'POST',
        body: { partKey, change },
      }),
    ),
};
