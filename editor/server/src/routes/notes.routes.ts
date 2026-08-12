// =============================================================================
// notes.routes.ts — パーツ単位メモ(版インスタンス=templateId 単位の取得/保存)
// =============================================================================
import { apiPaths } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { SaveNoteRequest } from '../openapi/schemas.js';
import * as notes from '../repositories/noteRepo.js';

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

// ⚠ ここに私有のスキーマを再定義しないこと。正典は `@editor/shared/schemas` の
// `SaveNoteRequest` で、複製すると上限(`pathKey`/`content` の `.max()`)が片方にしか
// 入らず、OpenAPI が公表する契約と実際に強制される契約が食い違う。

type NotesParams = { Params: { templateId: string } };

export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get<NotesParams>(apiPaths.notes, { preHandler: requireAuth }, async (request) => {
    return notes.listNotes(request.params.templateId);
  });

  app.put<NotesParams & { Body: z.infer<typeof SaveNoteRequest> }>(
    apiPaths.notes,
    { preHandler: [requireAuth, requireEditor, validate(SaveNoteRequest)] },
    async (request, reply) => {
      const body = request.body;
      await notes.saveNote(request.params.templateId, body.pathKey, body.content, actor(request));
      return reply.code(204).send();
    },
  );
}
