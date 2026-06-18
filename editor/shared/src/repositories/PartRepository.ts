import type {
  PartCatalogItem,
  PartClassificationOptions,
  PartClassificationQuery,
  PartHistoryEntry,
} from '../index.js';
import type { Result } from '../result.js';

/** Parts-catalog aggregate (editor left pane) + per-part edit history. */
export interface PartRepository {
  getPartClassificationOptions(
    query: PartClassificationQuery,
  ): Promise<Result<PartClassificationOptions>>;
  listParts(query: PartClassificationQuery): Promise<Result<PartCatalogItem[]>>;
  getPartHistory(templateId: string, partId: string): Promise<Result<PartHistoryEntry[]>>;
  /** Append one per-part edit-history entry (id/user/timestamp stamped by the impl). */
  recordPartChange(templateId: string, partId: string, change: string): Promise<Result<void>>;
}
