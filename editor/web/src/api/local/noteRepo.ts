// =============================================================================
// noteRepo.ts — パーツ単位メモ(版インスタンス単位)の local 実装(localStorage)
// =============================================================================
// 役割: `NoteRepository` の local 実装。`editor:notes` に
// `Record<templateId, Record<pathKey, PartNote>>` で保持し、版インスタンス単位で全件取得・
// 1 パーツ単位で保存(空文字は削除)する。templateId(委託会社/ファンドコード/基準日/版種を
// 内包)単位のキー設計なので、別の基準日/版種の版へは引き継がない。
import type { NoteRepository, PartNote } from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, write } from './store';

type NoteStore = Record<string, Record<string, PartNote>>;

export const localNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
      return delay(Object.values(all[templateId] ?? {}));
    }),

  saveNote: (templateId: string, pathKey: string, content: string) =>
    attempt(() => {
      const all = read<NoteStore>(K.notes, {});
      const tplNotes = all[templateId] ?? {};
      if (content.trim() === '') {
        // 空メモは削除に倒す(別 API を増やさない)。エントリごと消し、空オブジェクトも畳む。
        delete tplNotes[pathKey];
      } else {
        tplNotes[pathKey] = {
          templateId,
          pathKey,
          content,
          updatedAt: now(),
          updatedBy: currentUser()?.displayName ?? '不明',
        };
      }
      if (Object.keys(tplNotes).length === 0) delete all[templateId];
      else all[templateId] = tplNotes;
      write(K.notes, all);
    }),
};
