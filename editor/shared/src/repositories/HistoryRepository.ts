// =============================================================================
// HistoryRepository.ts — 監査証跡集約 (編集/PDF/作成の3履歴 + PDF 出力記録)
// =============================================================================
import type {
  CreateHistoryEntry,
  EditHistoryEntry,
  PdfHistoryEntry,
  TemplateSnapshot,
  TemplateVersionMeta,
} from '../index.js';
import type { Result } from '../result.js';

/** 監査証跡の集約: グローバルな3種の履歴フィード + PDF 出力の記録。 */
export interface HistoryRepository {
  getEditHistory(): Promise<Result<EditHistoryEntry[]>>;
  getPdfHistory(): Promise<Result<PdfHistoryEntry[]>>;
  getCreateHistory(): Promise<Result<CreateHistoryEntry[]>>;
  /** プレビュー画面から実行した PDF 出力を記録する。 */
  recordPdfExport(templateId: string): Promise<Result<void>>;
  /**
   * snapshot を持つテンプレの確定版を新しい順に返す。
   * 比較画面のバージョン選択で使う。
   */
  listVersions(templateId: string): Promise<Result<TemplateVersionMeta[]>>;
  /**
   * 1 件の編集履歴に対して捕捉した、凍結済み HTML/CSS の snapshot。
   *
   * `templateId` は「その版のどのテンプレか」を決める。1 コミットが複数のテンプレに
   * 触れているとき hash だけでは対象が定まらないため、版一覧から開く呼び出しは必ず
   * 渡すこと(省略した場合、対象が 1 つに絞れなければエラーになる)。
   */
  getSnapshot(historyId: string, templateId?: string): Promise<Result<TemplateSnapshot>>;
}
