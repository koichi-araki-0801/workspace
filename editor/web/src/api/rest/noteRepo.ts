// =============================================================================
// noteRepo.ts — パーツ単位コメント(1 段の入れ子スレッド)の REST 実装
// =============================================================================
// 役割: `NoteRepository` の REST 実装。一覧は GET、追加は POST、編集は PATCH、削除は
// DELETE で叩く。並び順はサーバが決める(web では並べ直さない — 2 箇所に並び順を持つと
// 片方だけがずれる)。インタフェースは local 実装と同一で、`repositories.ts` の差し替え
// だけで切替わる。
import {
  type AddNoteOptions,
  apiPaths,
  buildPath,
  type NotePatch,
  type NoteRepository,
  type PartNoteEntry,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attemptRest(() => apiFetch<PartNoteEntry[]>(buildPath(apiPaths.notes, { templateId }))),

  addNote: (templateId: string, pathKey: string, content: string, opts: AddNoteOptions = {}) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.notes, { templateId }), {
        method: 'POST',
        body: { pathKey, content, replyTo: opts.replyTo ?? null, kind: opts.kind ?? 'note' },
      }),
    ),

  updateNote: (templateId: string, entryId: string, patch: NotePatch) =>
    attemptRest(() =>
      apiFetch<PartNoteEntry>(buildPath(apiPaths.noteEntry, { templateId, entryId }), {
        method: 'PATCH',
        body: patch,
      }),
    ),

  deleteNote: (templateId: string, entryId: string) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.noteEntry, { templateId, entryId }), { method: 'DELETE' }),
    ),
};
