import type {
  CreateHistoryEntry,
  EditHistoryEntry,
  PdfHistoryEntry,
  TemplateSnapshot,
  TemplateVersionMeta,
} from '../index.js';
import type { Result } from '../result.js';

/** Audit-trail aggregate: the three global history feeds + PDF-export recording. */
export interface HistoryRepository {
  getEditHistory(): Promise<Result<EditHistoryEntry[]>>;
  getPdfHistory(): Promise<Result<PdfHistoryEntry[]>>;
  getCreateHistory(): Promise<Result<CreateHistoryEntry[]>>;
  /** Record a PDF export performed from the preview screen. */
  recordPdfExport(templateId: string): Promise<Result<void>>;
  /**
   * Confirmed versions of a template that have a stored snapshot, newest first.
   * Used by the compare screen's version pickers.
   */
  listVersions(templateId: string): Promise<Result<TemplateVersionMeta[]>>;
  /** The frozen HTML/CSS snapshot captured for one edit-history entry. */
  getSnapshot(historyId: string): Promise<Result<TemplateSnapshot>>;
}
