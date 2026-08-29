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
  /** 指定版インスタンスの全パーツ履歴を返す(`partKey` 絞りは呼び出し側で行う)。無ければ空配列。 */
  listPartHistory(templateId: string): Promise<Result<PartHistoryEntry[]>>;
  /** パーツ別編集履歴を 1 件追記する (id/user/timestamp は実装側で付与)。`partKey` は構造パスキー。 */
  recordPartChange(templateId: string, partKey: string, change: string): Promise<Result<void>>;
}
