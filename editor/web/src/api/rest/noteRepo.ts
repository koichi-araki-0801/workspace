// =============================================================================
// noteRepo.ts — パーツ単位メモ(版インスタンス単位)の REST 実装
// =============================================================================
// 役割: `NoteRepository` の REST 実装。`/templates/:templateId/notes` を GET(全件)/ PUT(1 件)
// で叩く。インタフェースは local 実装と同一で、`repositories.ts` の差し替えだけで切替わる。
import { apiPaths, buildPath, type NoteRepository, type PartNote } from '@editor/shared';
import { apiFetch, attemptRest } from './http';

export const restNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attemptRest(() => apiFetch<PartNote[]>(buildPath(apiPaths.notes, { templateId }))),

  saveNote: (templateId: string, pathKey: string, content: string) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.notes, { templateId }), {
        method: 'PUT',
        body: { pathKey, content },
      }),
    ),
};
