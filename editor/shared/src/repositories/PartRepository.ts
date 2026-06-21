// =============================================================================
// PartRepository.ts — パーツカタログ集約 (エディタ左ペイン) + パーツ別編集履歴
// =============================================================================
import type {
  PartCatalogItem,
  PartClassificationOptions,
  PartClassificationQuery,
  PartHistoryEntry,
} from '../index.js';
import type { Result } from '../result.js';

/** パーツカタログ集約 (エディタ左ペイン) + パーツ単位の編集履歴。 */
export interface PartRepository {
  getPartClassificationOptions(
    query: PartClassificationQuery,
  ): Promise<Result<PartClassificationOptions>>;
  listParts(query: PartClassificationQuery): Promise<Result<PartCatalogItem[]>>;
  getPartHistory(templateId: string, partId: string): Promise<Result<PartHistoryEntry[]>>;
  /** パーツ別編集履歴を 1 件追記する (id/user/timestamp は実装側で付与)。 */
  recordPartChange(templateId: string, partId: string, change: string): Promise<Result<void>>;
}
