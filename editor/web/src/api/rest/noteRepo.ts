// =============================================================================
// noteRepo.ts — パーツ単位メモ(追記型スレッド)の REST 実装
// =============================================================================
// 役割: `NoteRepository` の REST 実装。一覧は GET、追加は POST、編集は PATCH、削除は
// DELETE で叩く。ペアのマージ・並び順はサーバが決める(web では並べ直さない — 2 箇所に
// 並び順を持つと片方だけがずれる)。インタフェースは local 実装と同一で、
// `repositories.ts` の差し替えだけで切替わる。
import { apiPaths, buildPath, type NoteRepository, type PartNoteEntry } from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attemptRest(() => apiFetch<PartNoteEntry[]>(buildPath(apiPaths.notes, { templateId }))),

  addNote: (templateId: string, pathKey: string, content: string) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.notes, { templateId }), {
        method: 'POST',
        body: { pathKey, content },
      }),
    ),

  updateNote: (templateId: string, entryId: string, content: string) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.noteEntry, { templateId, entryId }), {
        method: 'PATCH',
        body: { content },
      }),
    ),

  deleteNote: (templateId: string, entryId: string) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.noteEntry, { templateId, entryId }), { method: 'DELETE' }),
    ),
};
