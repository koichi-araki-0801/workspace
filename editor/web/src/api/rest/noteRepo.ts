// =============================================================================
// noteRepo.ts — パーツ単位メモ(版インスタンス単位)の REST 実装
// =============================================================================
// 役割: `NoteRepository` の REST 実装。`/templates/:templateId/notes` を GET(全件)/ PUT(1 件)
// で叩く。インタフェースは local 実装と同一で、`repositories.ts` の差し替えだけで切替わる。
import type { NoteRepository, PartNote } from '@editor/shared';
import { apiFetch, attemptRest } from './http';

const enc = encodeURIComponent;

export const restNoteRepo: NoteRepository = {
  listNotes: (templateId: string) =>
    attemptRest(() => apiFetch<PartNote[]>(`/templates/${enc(templateId)}/notes`)),

  saveNote: (templateId: string, pathKey: string, content: string) =>
    attemptRest(() =>
      apiFetch<void>(`/templates/${enc(templateId)}/notes`, {
        method: 'PUT',
        body: { pathKey, content },
      }),
    ),
};
