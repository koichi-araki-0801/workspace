// =============================================================================
// notes.routes.ts — パーツ単位コメント(1 段の入れ子スレッド)の取得・追加・更新・削除
// =============================================================================
import { apiPaths } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AddNoteRequest, UpdateNoteRequest } from '../openapi/schemas.js';
import * as notes from '../repositories/noteRepo.js';

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

// ⚠ ここに私有のスキーマを再定義しないこと。正典は `@editor/shared/schemas` の
// `AddNoteRequest` / `UpdateNoteRequest` で、複製すると上限(`pathKey`/`content` の
// `.max()`)が片方にしか入らず、OpenAPI が公表する契約と実際に強制される契約が食い違う。

type NotesParams = { Params: { templateId: string } };
type EntryParams = { Params: { templateId: string; entryId: string } };

export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get<NotesParams>(apiPaths.notes, { preHandler: requireAuth }, async (request) => {
    return notes.listNotes(request.params.templateId);
  });

  app.post<NotesParams & { Body: z.infer<typeof AddNoteRequest> }>(
    apiPaths.notes,
    { preHandler: [requireAuth, requireEditor, validate(AddNoteRequest)] },
    async (request, reply) => {
      const body = request.body;
      const entry = await notes.addNote(
        request.params.templateId,
        body.pathKey,
        body.content,
        actor(request),
        { replyTo: body.replyTo, kind: body.kind },
      );
      return reply.code(201).send(entry);
    },
  );

  app.patch<EntryParams & { Body: z.infer<typeof UpdateNoteRequest> }>(
    apiPaths.noteEntry,
    { preHandler: [requireAuth, requireEditor, validate(UpdateNoteRequest)] },
    async (request) => {
      const { templateId, entryId } = request.params;
      const { content, status } = request.body;
      return notes.updateNote(templateId, entryId, { content, status }, actor(request));
    },
  );

  app.delete<EntryParams>(
    apiPaths.noteEntry,
    { preHandler: [requireAuth, requireEditor] },
    async (request, reply) => {
      const { templateId, entryId } = request.params;
      await notes.deleteNote(templateId, entryId);
      return reply.code(204).send();
    },
  );
}
