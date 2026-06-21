// =============================================================================
// historyService.ts — 編集/PDF/作成の 3 履歴フィードをまとめて取得する service
// =============================================================================
import {
  type CreateHistoryEntry,
  type EditHistoryEntry,
  type HistoryRepository,
  isErr,
  ok,
  type PdfHistoryEntry,
  type Result,
} from '@editor/shared';
import { useHistoryRepo } from '@/api/repositories';

export interface AllHistory {
  edits: EditHistoryEntry[];
  pdfs: PdfHistoryEntry[];
  creates: CreateHistoryEntry[];
}

export interface HistoryService {
  /** 3 つの履歴フィードを並行取得する。最初の error で即座に fail-fast する。 */
  loadAll(): Promise<Result<AllHistory>>;
}

export function createHistoryService(repo: HistoryRepository): HistoryService {
  return {
    async loadAll() {
      const [edits, pdfs, creates] = await Promise.all([
        repo.getEditHistory(),
        repo.getPdfHistory(),
        repo.getCreateHistory(),
      ]);
      if (isErr(edits)) return edits;
      if (isErr(pdfs)) return pdfs;
      if (isErr(creates)) return creates;
      return ok({ edits: edits.value, pdfs: pdfs.value, creates: creates.value });
    },
  };
}

export const useHistoryService = (): HistoryService => createHistoryService(useHistoryRepo());
