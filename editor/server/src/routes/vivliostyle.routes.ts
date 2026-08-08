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
// zip アップロード(project モード)は `routes/zipBodyParser.ts` の content-type parser が
// `application/zip` / `application/octet-stream` を Buffer 化して `request.body` に載せる。
// inline(JSON)は通常の JSON パーサが object を載せる。両者は `Buffer.isBuffer` で判別する。
// ⚠ そのパーサの登録は**この plugin の中**でしか行わない(ルートインスタンスへ戻すと
// 全ルートへ伝播し、`bodyLimit` の効かない 64MB バッファが任意の POST で開く)。
import { apiPaths, notFound, validation } from '@editor/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { config } from '../config.js';
import { actorFromReq, audit, auditedRethrow } from '../logger.js';
import { requireAuth, requireEditor } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { BuildInlineRequest, BuildMergeRequest } from '../openapi/schemas.js';
import {
  buildInlinePdf,
  buildMergedPdf,
  buildProjectInSlot,
  prepareInlineDoc,
  withBuildSlot,
} from '../vivliostyle/build.js';
import type { PreviewActor } from '../vivliostyle/previewManager.js';
import { UUID_RE } from '../vivliostyle/previewManager.js';
import { allowForwardPath, DEFAULT_DOC_BASE, proxyToPreview } from '../vivliostyle/previewProxy.js';
import { previewManager } from '../vivliostyle/previewServer.js';
import {
  cleanupProject,
  extractProjectZip,
  safeProjectEntry,
} from '../vivliostyle/projectInput.js';
import { registerZipBodyParser } from './zipBodyParser.js';

const PREVIEW_HOST = config.vivliostyle.preview.host;

/**
 * プレビューセッションの所有者判定に使う主体。監査用の `actorFromReq`(`logger.ts`)は
 * 未認証を `anonymous` へ潰す仕様なので**流用しない** — 認可判定で複数の未認証主体を
 * 1 つの名前へ畳むと、そこが全一致の抜け道になる。
 * ローカルモード(`requireAuth=false`)は単一端末利用が前提なので、センチネル actor で
 * 意図的に全一致させる(素通しであることは `previewOwnership.test.ts` が固定する)。
 */
function actorOf(request: FastifyRequest): PreviewActor {
  if (!config.requireAuth) return { loginId: '@local', isAdmin: true };
  const u = request.user;
  if (!u) throw notFound('プレビューセッションが見つかりません');
  return { loginId: u.username, isAdmin: u.role === 'admin' };
}

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
  registerZipBodyParser(app);

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
    { preHandler: [requireAuth, requireEditor] },
    async (request, reply) => {
      const zip = request.body;
      // ⚠ zip の展開は**枠を取ってから**行う(`withBuildSlot` の内側)。枠の外で展開していた
      // 版は、順番待ちのあいだずっと展開済みディレクトリを握ったので、行列の長さがそのまま
      // ディスク消費だった(inline / merge の資源確保を枠の内側へ寄せたのと同じ理由)。
      const pdf = await withBuildSlot(async (runBuild) => {
        const project = await extractProjectZip(zip);
        const detail = { mode: 'project', files: project.fileCount, bytes: zip.length };
        try {
          // `entry` 検証も try の内側に置く。外に出すと 400 の時だけ展開ディレクトリが残る。
          const opts = projectOptions(request, project.dir);
          return await auditedRethrow(
            request,
            'pdf.export',
            () =>
              buildProjectInSlot(
                {
                  dir: project.dir,
                  config: project.config,
                  entry: opts.entry,
                  size: opts.size,
                  singleDoc: opts.singleDoc,
                },
                runBuild,
              ),
            {
              success: (pdf) => ({ detail: { ...detail, pdfBytes: pdf.length } }),
              failure: () => ({ detail }),
              failureMessage: 'PDF generation failed',
            },
          );
        } finally {
          await cleanupProject(project.dir);
        }
      });
      sendPdf(reply, pdf);
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

  // GET /api/preview — 稼働中のプレビューセッション一覧(メタデータのみ・自分の分だけ)。
  // 全件返していた頃は、id を列挙してプロキシ経由で他人の作業を読めた(IDOR の足場)。
  app.get(apiPaths.preview, { preHandler: requireAuth }, async (request) => {
    return previewManager.list(actorOf(request));
  });

  // POST /api/preview — ライブプレビューを起動(inline JSON または project zip)。
  app.post(
    apiPaths.preview,
    { preHandler: [requireAuth, requireEditor] },
    async (request, reply) => {
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
        meta = await previewManager.start(
          {
            mode: 'project',
            config: project.config,
            cwd: project.dir,
            input: opts.entry,
            size: opts.size,
            singleDoc: opts.singleDoc,
            workDir: project.dir,
            docBase: project.docBase,
          },
          actorOf(request),
        );
      } else {
        const parsed = BuildInlineRequest.safeParse(request.body);
        if (!parsed.success) throw validation('リクエスト内容が不正です');
        const { dir, entry } = await prepareInlineDoc(parsed.data);
        meta = await previewManager.start(
          {
            mode: 'inline',
            input: entry,
            cwd: dir,
            size: parsed.data.size,
            singleDoc: parsed.data.singleDoc,
            workDir: dir,
            // inline は config を持たないので CLI 既定の base になる。
            docBase: DEFAULT_DOC_BASE,
          },
          actorOf(request),
        );
      }
      audit({
        event: 'vivliostyle.preview.start',
        outcome: 'success',
        ...actorFromReq(request),
        resource: { id: meta.id },
        detail: { mode: meta.mode },
      });
      return reply.code(201).send(meta);
    },
  );

  // GET /api/preview/:id — セッションのメタデータ。
  app.get<{ Params: { id: string } }>(
    apiPaths.previewById,
    { preHandler: requireAuth },
    async (request) => {
      // 他人のセッションも「見つかりません」に合流させる(403 は存在オラクルになる)。
      const meta = previewManager.get(request.params.id, actorOf(request));
      if (!meta) throw notFound('プレビューセッションが見つかりません');
      return meta;
    },
  );

  // DELETE /api/preview/:id — セッションを停止する。
  app.delete<{ Params: { id: string } }>(
    apiPaths.previewById,
    { preHandler: [requireAuth, requireEditor] },
    async (request, reply) => {
      const id = request.params.id;
      // 空振りは workDir も消さない(`stop` は cleanupProject まで行うため、素通しすると
      // 他人の作業ディレクトリを消せる)。
      const stopped = await previewManager.stop(id, actorOf(request));
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

  // GET|HEAD /api/preview/:id/* — ループバックの Vite プレビューサーバへ reverse-proxy する。
  // 完全一致の :id ルートより末尾スラッシュ付きが優先されないよう、ワイルドカードで受ける。
  //
  // **`app.all` にしない。** POST を登録すると `app.ts` の content-type parser が
  // preHandler より前にボディを Buffer 化し(最大 `maxProjectBytes`)、消費済みストリームを
  // pipe しようとして上流が宙吊りになる。メソッドを登録しなければルーティング自体が起きない。
  app.route({
    method: ['GET', 'HEAD'],
    url: `${apiPaths.previewById}/*`,
    preHandler: requireAuth,
    handler: async (request, reply) => {
      // 生 URL から id と残差を切り出す。`request.params.id` は find-my-way が復号済みで
      // 生 URL と長さが合わず、`slice` すると**検査する文字列と転送する文字列がずれる**
      // (`%2D` で書いた UUID など)。許可リストを載せる以上、この算術は置けない。
      const m = /^\/api\/preview\/([^/?#]+)((?:\/[^?#]*)?(?:[?#].*)?)$/.exec(request.url);
      // hijack 前なので、ここでの throw は通常どおり 404 として errorHandler が処理する。
      if (!m) throw notFound('プレビューセッションが見つかりません');
      const rawId = m[1];
      // セッション id は `crypto.randomUUID`。literal UUID 以外は受けない(encode 揺れを
      // 型ごと排除する)。
      if (!UUID_RE.test(rawId)) throw notFound('プレビューセッションが見つかりません');
      const target = previewManager.resolveFor(rawId, actorOf(request));
      if (!target) throw notFound('プレビューセッションが見つかりません');
      const forward = allowForwardPath(m[2] || '/', target.docBase);
      // 許可リスト非該当は**上流へ 1 バイトも出さずに**落とす。上流へ届けてから 404 に
      // すると、応答時間差や上流ログで存在が漏れる。
      if (!forward) throw notFound('このパスはプレビューでは配信されません');
      previewManager.touch(rawId);
      // Fastify の応答送出を抑止し、proxy が生 res を完全所有する。
      reply.hijack();
      proxyToPreview(PREVIEW_HOST, target.port, forward, request.raw, reply.raw);
    },
  });
}
