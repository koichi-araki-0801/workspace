import {
  type CreateHistoryEntry,
  type EditHistoryEntry,
  type HistoryRepository,
  notFound,
  type PdfHistoryEntry,
  type TemplateSnapshot,
  type TemplateVersionMeta,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, uid, write } from './store';

export const localHistoryRepo: HistoryRepository = {
  getEditHistory: () => attempt(() => delay(read<EditHistoryEntry[]>(K.editHist, []))),
  getPdfHistory: () => attempt(() => delay(read<PdfHistoryEntry[]>(K.pdfHist, []))),
  getCreateHistory: () => attempt(() => delay(read<CreateHistoryEntry[]>(K.createHist, []))),

  recordPdfExport: (templateId: string) =>
    attempt(() => {
      const user = currentUser();
      const hist = read<PdfHistoryEntry[]>(K.pdfHist, []);
      hist.unshift({
        id: uid('ph'),
        templateId,
        user: user?.displayName ?? '不明',
        timestamp: now(),
      });
      write(K.pdfHist, hist);
    }),

  listVersions: (templateId: string) =>
    attempt(() => {
      const snapshots = read<Record<string, TemplateSnapshot>>(K.snapshots, {});
      // editHist is already newest-first; keep only this template's entries that
      // have a stored snapshot.
      const versions: TemplateVersionMeta[] = read<EditHistoryEntry[]>(K.editHist, [])
        .filter((e) => e.templateId === templateId && snapshots[e.id])
        .map((e) => ({
          historyId: e.id,
          templateId: e.templateId,
          timestamp: e.timestamp,
          user: e.user,
          summary: e.summary,
        }));
      return delay(versions);
    }),

  getSnapshot: (historyId: string) =>
    attempt(() => {
      const snapshots = read<Record<string, TemplateSnapshot>>(K.snapshots, {});
      const snap = snapshots[historyId];
      if (!snap) throw notFound(`この版の比較データがありません: ${historyId}`);
      return delay(snap);
    }),
};
