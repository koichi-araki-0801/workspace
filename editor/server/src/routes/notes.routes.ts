// =============================================================================
// notes.routes.ts — パーツ単位メモ(版インスタンス=templateId 単位の取得/保存)
// =============================================================================
import { apiPaths } from '@editor/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as notes from '../repositories/noteRepo.js';

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

/** メモ保存リクエスト。`content` 空文字は削除に倒す(repo 側で処理)。 */
const SaveNoteRequest = z.object({
  pathKey: z.string().min(1),
  content: z.string(),
});

type NotesParams = { Params: { templateId: string } };

export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get<NotesParams>(apiPaths.notes, { preHandler: requireAuth }, async (request) => {
    return notes.listNotes(request.params.templateId);
  });

  app.put<NotesParams & { Body: z.infer<typeof SaveNoteRequest> }>(
    apiPaths.notes,
    { preHandler: [requireAuth, validate(SaveNoteRequest)] },
    async (request, reply) => {
      const body = request.body;
      await notes.saveNote(request.params.templateId, body.pathKey, body.content, actor(request));
      return reply.code(204).send();
    },
  );
}
