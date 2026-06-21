// =============================================================================
// history.routes.ts — 履歴フィード / PDF 出力記録 / バージョン一覧 / スナップショット
// =============================================================================
import { Router } from 'express';
import type { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { RecordPdfExportRequest } from '../openapi/schemas.js';
import * as history from '../repositories/historyRepo.js';

export const historyRouter = Router();

const actor = (req: { user?: { username?: string } }): string => req.user?.username ?? 'system';

historyRouter.get('/history/edit', requireAuth, async (_req, res) => {
  res.json(await history.getEditHistory());
});

historyRouter.get('/history/pdf', requireAuth, async (_req, res) => {
  res.json(await history.getPdfHistory());
});

historyRouter.post(
  '/history/pdf',
  requireAuth,
  validate(RecordPdfExportRequest),
  async (req, res) => {
    const body = req.body as z.infer<typeof RecordPdfExportRequest>;
    await history.recordPdfExport(body.templateId, actor(req));
    res.status(204).end();
  },
);

historyRouter.get('/history/create', requireAuth, async (_req, res) => {
  res.json(await history.getCreateHistory());
});

historyRouter.get('/templates/:templateId/versions', requireAuth, async (req, res) => {
  res.json(await history.listVersions(String(req.params.templateId)));
});

historyRouter.get('/snapshots/:historyId', requireAuth, async (req, res) => {
  res.json(await history.getSnapshot(String(req.params.historyId)));
});
