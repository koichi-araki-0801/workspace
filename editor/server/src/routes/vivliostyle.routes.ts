// =============================================================================
// vivliostyle.routes.ts — vivliostyle build / preview の HTTP API ルータ
// =============================================================================
// このルータ(と `vivliostyle/*`)だけが `@vivliostyle/cli` を駆動する唯一の場所。
//
// preview では `strict` ルーティングが重要: `GET /preview/:id`(メタデータ)が末尾
// スラッシュ付きビューア URL `/preview/:id/` にもマッチするのを防ぐ。後者(およびアセット
// サブパス)は下の reverse-proxy 用 `.use` へフォールスルーさせたい。
import { notFound, validation } from '@editor/shared';
import { type Request, type Response, Router } from 'express';
import type { z } from 'zod';
import { config } from '../config.js';
import { actorFromReq, audit, auditedRethrow } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { BuildInlineRequest } from '../openapi/schemas.js';
import { buildInlinePdf, buildProjectPdf, prepareInlineDoc } from '../vivliostyle/build.js';
import { proxyToPreview } from '../vivliostyle/previewProxy.js';
import { previewManager } from '../vivliostyle/previewServer.js';
import { cleanupProject, extractProjectZip } from '../vivliostyle/projectInput.js';

// `strict: true` の理由はファイル先頭ヘッダを参照。
export const vivliostyleRouter = Router({ strict: true });

const PREVIEW_HOST = config.vivliostyle.preview.host;

function sendPdf(res: Response, pdf: Buffer): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
  res.send(pdf);
}

/** リクエストボディがアップロードされた zip(project モード)なら true。 */
function isZip(req: Request): boolean {
  return req.is(['application/zip', 'application/octet-stream']) !== false;
}

/**
 * 生のリクエストボディ(project zip)をバイト数の上限付きで収集する。zip アップロードは
 * `application/zip` を使い、グローバルの `express.json` はこれを無視するため、ストリームは
 * ここで未消費のまま残る。上限超過は `validation`(400)。
 */
function readZipBody(req: Request): Promise<Buffer> {
  const limit = config.vivliostyle.build.maxProjectBytes;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(validation('プロジェクトが大きすぎます'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** project build / preview で共有する任意のクエリ上書き。 */
function projectOptions(req: Request): { entry?: string; size?: string; singleDoc?: boolean } {
  const q = req.query;
  return {
    entry: typeof q.entry === 'string' ? q.entry : undefined,
    size: typeof q.size === 'string' ? q.size : undefined,
    singleDoc: q.singleDoc === 'true',
  };
}

// POST /api/build — inline(レンダリング済み HTML + CSS)→ PDF。旧 /pdf を置き換える。
vivliostyleRouter.post('/build', requireAuth, validate(BuildInlineRequest), async (req, res) => {
  const body = req.body as z.infer<typeof BuildInlineRequest>;
  const detail = { mode: 'inline', htmlBytes: body.html.length, cssBytes: body.css.length };
  const pdf = await auditedRethrow(req, 'pdf.export', () => buildInlinePdf(body), {
    success: (pdf) => ({ detail: { ...detail, pdfBytes: pdf.length } }),
    failure: () => ({ detail }),
    failureMessage: 'PDF generation failed',
  });
  sendPdf(res, pdf);
});

// POST /api/build/project — vivliostyle の project zip → PDF。
vivliostyleRouter.post('/build/project', requireAuth, async (req, res) => {
  const zip = await readZipBody(req);
  const project = await extractProjectZip(zip);
  const opts = projectOptions(req);
  const detail = { mode: 'project', files: project.fileCount, bytes: zip.length };
  try {
    const pdf = await auditedRethrow(
      req,
      'pdf.export',
      () =>
        buildProjectPdf({
          dir: project.dir,
          configPath: project.configPath,
          entry: opts.entry,
          size: opts.size,
          singleDoc: opts.singleDoc,
        }),
      {
        success: (pdf) => ({ detail: { ...detail, pdfBytes: pdf.length } }),
        failure: () => ({ detail }),
        failureMessage: 'PDF generation failed',
      },
    );
    sendPdf(res, pdf);
  } finally {
    await cleanupProject(project.dir);
  }
});

// GET /api/preview — 稼働中のプレビューセッション一覧(メタデータのみ)。
vivliostyleRouter.get('/preview', requireAuth, (_req, res) => {
  res.json(previewManager.list());
});

// POST /api/preview — ライブプレビューを起動(inline JSON または project zip)。
vivliostyleRouter.post('/preview', requireAuth, async (req, res) => {
  let meta: Awaited<ReturnType<typeof previewManager.start>>;
  if (isZip(req)) {
    const zip = await readZipBody(req);
    const project = await extractProjectZip(zip);
    const opts = projectOptions(req);
    meta = await previewManager.start({
      mode: 'project',
      configPath: project.configPath,
      cwd: project.dir,
      input: opts.entry,
      size: opts.size,
      singleDoc: opts.singleDoc,
      workDir: project.dir,
    });
  } else {
    const parsed = BuildInlineRequest.safeParse(req.body);
    if (!parsed.success) throw validation('リクエスト内容が不正です');
    const { dir, entry } = await prepareInlineDoc(parsed.data);
    meta = await previewManager.start({
      mode: 'inline',
      input: entry,
      cwd: dir,
      size: parsed.data.size,
      singleDoc: parsed.data.singleDoc,
      workDir: dir,
    });
  }
  audit({
    event: 'vivliostyle.preview.start',
    outcome: 'success',
    ...actorFromReq(req),
    resource: { id: meta.id },
    detail: { mode: meta.mode },
  });
  res.status(201).json(meta);
});

// GET /api/preview/:id — セッションのメタデータ。
vivliostyleRouter.get('/preview/:id', requireAuth, (req, res) => {
  const meta = previewManager.get(req.params.id as string);
  if (!meta) throw notFound('プレビューセッションが見つかりません');
  res.json(meta);
});

// DELETE /api/preview/:id — セッションを停止する。
vivliostyleRouter.delete('/preview/:id', requireAuth, async (req, res) => {
  const id = req.params.id as string;
  const stopped = await previewManager.stop(id);
  if (!stopped) throw notFound('プレビューセッションが見つかりません');
  audit({
    event: 'vivliostyle.preview.stop',
    outcome: 'success',
    ...actorFromReq(req),
    resource: { id },
  });
  res.status(204).end();
});

// ALL /api/preview/:id/* — ループバックの Vite プレビューサーバへ reverse-proxy する。
// 完全一致の :id ルートより後に登録し、素のパスはそちらが優先されるようにする。
vivliostyleRouter.use('/preview/:id', requireAuth, (req, res, next) => {
  const id = req.params.id as string;
  const port = previewManager.portOf(id);
  if (port === undefined) {
    next(notFound('プレビューセッションが見つかりません'));
    return;
  }
  previewManager.touch(id);
  proxyToPreview(PREVIEW_HOST, port, req.url || '/', req, res);
});
