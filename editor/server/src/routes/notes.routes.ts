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

export async function notesRoutes(app: FastifyInstance): Promise<void> {
  app.get(apiPaths.notes, { preHandler: requireAuth }, async (request) => {
    return notes.listNotes(String((request.params as { templateId: string }).templateId));
  });

  app.put(
    apiPaths.notes,
    { preHandler: [requireAuth, validate(SaveNoteRequest)] },
    async (request, reply) => {
      const body = request.body as z.infer<typeof SaveNoteRequest>;
      await notes.saveNote(
        String((request.params as { templateId: string }).templateId),
        body.pathKey,
        body.content,
        actor(request),
      );
      return reply.code(204).send();
    },
  );
}
