// =============================================================================
// historyRepo.ts — 編集/PDF/作成履歴と版スナップショットの local 実装
// =============================================================================
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
      // `editHist` は既に新しい順。当該テンプレートかつ snapshot を持つ entry だけ残す。
      const versions: TemplateVersionMeta[] = read<EditHistoryEntry[]>(K.editHist, [])
        .filter((e) => e.templateId === templateId && snapshots[e.historyId])
        .map((e) => ({
          historyId: e.historyId,
          templateId: e.templateId,
          timestamp: e.timestamp,
          user: e.user,
          summary: e.summary,
        }));
      return delay(versions);
    }),

  // local の snapshot は履歴 id 単位で 1 件なので対象が曖昧にならない。`templateId` は
  // 指定があれば照合にだけ使う(rest と同じく別テンプレの内容を返さないため)。
  getSnapshot: (historyId: string, templateId?: string) =>
    attempt(() => {
      const snapshots = read<Record<string, TemplateSnapshot>>(K.snapshots, {});
      const snap = snapshots[historyId];
      if (!snap) throw notFound(`この版の比較データがありません: ${historyId}`);
      if (templateId !== undefined && snap.templateId !== templateId) {
        throw notFound(`この版に ${templateId} の変更は含まれていません: ${historyId}`);
      }
      return delay(snap);
    }),
};
