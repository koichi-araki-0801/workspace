// =============================================================================
// vivliostyle.routes.ts — vivliostyle build / preview の HTTP API ルータ
// =============================================================================
// このルータ(と `vivliostyle/*`)だけが `@vivliostyle/cli` を駆動する唯一の場所。
//
// strict ルーティングが重要: `GET /preview/:id`(メタデータ)が末尾スラッシュ付きビューア URL
// `/preview/:id/` にもマッチするのを防ぐ。後者(およびアセットサブパス)は reverse-proxy 用の
// ワイルドカード `/preview/:id/*` に流す。Fastify は既定で末尾スラッシュを区別(`ignoreTrailingSlash`
// が false)し、静的経路をワイルドカードより優先するため、この 2 経路で分離できる。
//
// zip アップロード(project モード)は `app.ts` の content-type parser が `application/zip` /
// `application/octet-stream` を Buffer 化して `request.body` に載せる。inline(JSON)は通常の
// JSON パーサが object を載せる。両者は `Buffer.isBuffer` で判別する。
import { apiPaths, notFound, validation } from '@editor/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { config } from '../config.js';
import { actorFromReq, audit, auditedRethrow } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { BuildInlineRequest, BuildMergeRequest } from '../openapi/schemas.js';
import {
  buildInlinePdf,
  buildMergedPdf,
  buildProjectPdf,
  prepareInlineDoc,
} from '../vivliostyle/build.js';
import { proxyToPreview } from '../vivliostyle/previewProxy.js';
import { previewManager } from '../vivliostyle/previewServer.js';
import {
  cleanupProject,
  extractProjectZip,
  safeProjectEntry,
} from '../vivliostyle/projectInput.js';

const PREVIEW_HOST = config.vivliostyle.preview.host;

function sendPdf(reply: FastifyReply, pdf: Buffer): void {
  reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', 'attachment; filename="report.pdf"')
    .send(pdf);
}

/**
 * project build / preview で共有する任意のクエリ上書き。
 *
 * `entry` は展開ディレクトリ `root` 配下の絶対パスへ解決してから返す。CLI は `input` を
 * 封じ込め無しで解決し URL も受け取るため、ここを通さずに渡すと任意ファイル読み出しと
 * SSRF になる(`safeProjectEntry` を見よ)。空文字は「指定なし」として扱い、従来どおり
 * config / CLI 既定に委ねる。
 */
function projectOptions(
  request: FastifyRequest,
  root: string,
): {
  entry?: string;
  size?: string;
  singleDoc?: boolean;
} {
  const q = request.query as Record<string, unknown>;
  const entry = typeof q.entry === 'string' && q.entry !== '' ? q.entry : undefined;
  return {
    entry: entry === undefined ? undefined : safeProjectEntry(root, entry),
    size: typeof q.size === 'string' ? q.size : undefined,
    singleDoc: q.singleDoc === 'true',
  };
}

export async function vivliostyleRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/build — inline(レンダリング済み HTML + CSS)→ PDF。旧 /pdf を置き換える。
  app.post<{ Body: z.infer<typeof BuildInlineRequest> }>(
    apiPaths.build,
    { preHandler: [requireAuth, validate(BuildInlineRequest)] },
    async (request, reply) => {
      const body = request.body;
      const detail = { mode: 'inline', htmlBytes: body.html.length, cssBytes: body.css.length };
      const pdf = await auditedRethrow(request, 'pdf.export', () => buildInlinePdf(body), {
        success: (pdf) => ({ detail: { ...detail, pdfBytes: pdf.length } }),
        failure: () => ({ detail }),
        failureMessage: 'PDF generation failed',
      });
      sendPdf(reply, pdf);
    },
  );

  // POST /api/build/project — vivliostyle の project zip → PDF。
  app.post<{ Body: Buffer }>(
    apiPaths.buildProject,
    { preHandler: requireAuth },
    async (request, reply) => {
      const zip = request.body;
      const project = await extractProjectZip(zip);
      const detail = { mode: 'project', files: project.fileCount, bytes: zip.length };
      try {
        // `entry` 検証も try の内側に置く。外に出すと 400 の時だけ展開ディレクトリが残る。
        const opts = projectOptions(request, project.dir);
        const pdf = await auditedRethrow(
          request,
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
        sendPdf(reply, pdf);
      } finally {
        await cleanupProject(project.dir);
      }
    },
  );

  // POST /api/build/merge — 複数のレンダリング済み文書 → 通しページ番号付きの 1 PDF。
  app.post<{ Body: z.infer<typeof BuildMergeRequest> }>(
    apiPaths.buildMerge,
    {
      // 複数 HTML を 1 つの JSON に載せるためグローバル bodyLimit(8MB)では足りない。
      // zip 経路の `maxProjectBytes` と同じ発想で、結合専用の上限へルート単位で引き上げる。
      bodyLimit: config.vivliostyle.build.maxMergeBytes,
      preHandler: [requireAuth, validate(BuildMergeRequest)],
    },
    async (request, reply) => {
      const body = request.body;
      const detail = {
        mode: 'merge',
        docCount: body.documents.length,
        htmlBytes: body.documents.reduce((n, d) => n + d.html.length, 0),
      };
      const pdf = await auditedRethrow(request, 'pdf.export', () => buildMergedPdf(body), {
        success: (pdf) => ({ detail: { ...detail, pdfBytes: pdf.length } }),
        failure: () => ({ detail }),
        failureMessage: 'PDF generation failed',
      });
      sendPdf(reply, pdf);
    },
  );

  // GET /api/preview — 稼働中のプレビューセッション一覧(メタデータのみ)。
  app.get(apiPaths.preview, { preHandler: requireAuth }, async () => {
    return previewManager.list();
  });

  // POST /api/preview — ライブプレビューを起動(inline JSON または project zip)。
  app.post(apiPaths.preview, { preHandler: requireAuth }, async (request, reply) => {
    let meta: Awaited<ReturnType<typeof previewManager.start>>;
    if (Buffer.isBuffer(request.body)) {
      const zip = request.body;
      const project = await extractProjectZip(zip);
      // `previewManager.start` は起動失敗時に `workDir` を掃除するが、その手前で弾く
      // `entry` 検証は自分で後始末する(展開ディレクトリを残さない)。
      let opts: ReturnType<typeof projectOptions>;
      try {
        opts = projectOptions(request, project.dir);
      } catch (e) {
        await cleanupProject(project.dir);
        throw e;
      }
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
      const parsed = BuildInlineRequest.safeParse(request.body);
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
      ...actorFromReq(request),
      resource: { id: meta.id },
      detail: { mode: meta.mode },
    });
    return reply.code(201).send(meta);
  });

  // GET /api/preview/:id — セッションのメタデータ。
  app.get<{ Params: { id: string } }>(
    apiPaths.previewById,
    { preHandler: requireAuth },
    async (request) => {
      const meta = previewManager.get(request.params.id);
      if (!meta) throw notFound('プレビューセッションが見つかりません');
      return meta;
    },
  );

  // DELETE /api/preview/:id — セッションを停止する。
  app.delete<{ Params: { id: string } }>(
    apiPaths.previewById,
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;
      const stopped = await previewManager.stop(id);
      if (!stopped) throw notFound('プレビューセッションが見つかりません');
      audit({
        event: 'vivliostyle.preview.stop',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { id },
      });
      return reply.code(204).send();
    },
  );

  // ALL /api/preview/:id/* — ループバックの Vite プレビューサーバへ reverse-proxy する。
  // 完全一致の :id ルートより末尾スラッシュ付きが優先されないよう、ワイルドカードで受ける。
  app.all<{ Params: { id: string } }>(
    `${apiPaths.previewById}/*`,
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;
      const port = previewManager.portOf(id);
      // hijack 前なので、ここでの throw は通常どおり 404 として errorHandler が処理する。
      if (port === undefined) throw notFound('プレビューセッションが見つかりません');
      previewManager.touch(id);
      // mount 後の残差パス + query を復元する(例 `/`, `/assets/x.js?foo=1`)。
      const forwardPath = request.url.slice(`/api/preview/${id}`.length) || '/';
      // Fastify の応答送出を抑止し、proxy が生 res を完全所有する。
      reply.hijack();
      proxyToPreview(PREVIEW_HOST, port, forwardPath, request.raw, reply.raw);
    },
  );
}
