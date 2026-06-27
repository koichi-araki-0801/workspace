// =============================================================================
// notes.routes.ts — パーツ単位メモ(版インスタンス=templateId 単位の取得/保存)
// =============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as notes from '../repositories/noteRepo.js';

export const notesRouter = Router();

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

/** メモ保存リクエスト。`content` 空文字は削除に倒す(repo 側で処理)。 */
const SaveNoteRequest = z.object({
  pathKey: z.string().min(1),
  content: z.string(),
});

notesRouter.get('/templates/:templateId/notes', requireAuth, async (req, res) => {
  res.json(await notes.listNotes(String(req.params.templateId)));
});

notesRouter.put(
  '/templates/:templateId/notes',
  requireAuth,
  validate(SaveNoteRequest),
  async (req, res) => {
    const body = req.body as z.infer<typeof SaveNoteRequest>;
    await notes.saveNote(String(req.params.templateId), body.pathKey, body.content, actor(req));
    res.status(204).end();
  },
);
