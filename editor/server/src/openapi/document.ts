// =============================================================================
// document.ts — editor API の OpenAPI 3.1 ドキュメント
// =============================================================================
// `schemas.ts` の Zod スキーマから `zod-openapi` の `createDocument` で生成する。
// `@editor/shared` の Repository インタフェース(Template / Auth / User / History /
// Part)が定める全データアクセス契約を網羅する。現状実装済みのエンドポイントと
// Phase 2 設計分の両方を含む。
//
// 現時点で稼働中の Express ハンドラに紐づくエンドポイント:
//   GET /api/health, GET /api/templates/options, GET /api/templates,
//   GET /api/templates/:id, PUT /api/templates/:id, POST /api/generate,
//   POST /api/build, POST /api/build/project, /api/preview*.
// 以下のその他のパスは design-first(契約のみ文書化、ハンドラ未実装)。
import { apiPaths, toOpenApiPath } from '@editor/shared';
import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import * as s from './schemas.js';

// ── 1. response helpers — レスポンス定義のヘルパ ──

/** 与えた Zod スキーマを持つ `application/json` レスポンス。 */
const json = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

/** 共有 `AppError` コンポーネントを参照する `application/json` エラーレスポンス。 */
const err = (description: string) => json(description, s.AppError);

const ERR_400 = { '400': err('リクエスト検証エラー (kind=validation)') };
const ERR_401 = { '401': err('未認証 (kind=unauthorized)') };
const ERR_403 = { '403': err('権限不足 (admin 限定など)') };
const ERR_404 = { '404': err('対象が存在しない (kind=not_found)') };
const ERR_409 = { '409': err('競合 (kind=conflict)') };
const ERR_500 = { '500': err('サーバ内部エラー (kind=unexpected)') };

/** 204 No Content レスポンス。 */
const noContent = (description: string) => ({ description });

// PDF のバイナリペイロード(OpenAPI 3.1: string/binary)。
const PdfBinary = z.string().meta({ format: 'binary', description: 'PDF バイナリ' });

export function buildOpenApiDocument() {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'editor API',
      version: '0.1.0',
      description:
        'Jinja2 テンプレート GUI 編集アプリのバックエンド API。\n\n' +
        '`@editor/shared` の Repository 契約(Template / Auth / User / History / Part)を ' +
        'REST として設計したもの。一部は Phase 2 の設計(ハンドラ未実装)。',
    },
    servers: [{ url: '/api', description: '同一オリジン (server が SPA も配信)' }],
    tags: [
      { name: 'system', description: 'ヘルスチェック等' },
      { name: 'auth', description: '認証・セッション' },
      { name: 'templates', description: 'テンプレートの探索・生成・下書き・確定保存' },
      { name: 'parts', description: 'パーツカタログ(エディタ左ペイン)' },
      { name: 'notes', description: 'パーツ単位の作業メモ(版インスタンス単位)' },
      { name: 'reviews', description: '確定保存の精査者承認ワークフロー' },
      { name: 'history', description: '編集 / PDF / 作成 履歴とバージョン比較' },
      { name: 'vivliostyle', description: 'vivliostyle build (PDF) / preview (ライブ)' },
      { name: 'users', description: 'ユーザ管理(admin 限定)' },
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'editor.sid',
          description: 'ログイン時に発行されるセッション cookie。',
        },
      },
    },
    // 既定: 各オペレーションは `security: []` を指定しない限りセッションを要求する。
    security: [{ sessionCookie: [] }],
    paths: {
      // ── 1. system ──
      '/health': {
        get: {
          tags: ['system'],
          summary: 'ヘルスチェック',
          operationId: 'getHealth',
          security: [],
          responses: { '200': json('OK', s.HealthResult) },
        },
      },

      // ── 2. auth ──
      '/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'ログイン',
          operationId: 'login',
          security: [],
          requestBody: { content: { 'application/json': { schema: s.LoginRequest } } },
          responses: {
            '200': json('ログイン成功(セッション cookie を Set-Cookie)', s.LoginResult),
            ...ERR_400,
            '401': err('資格情報が不正、またはユーザ無効'),
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'ログアウト',
          operationId: 'logout',
          responses: { '204': noContent('ログアウト完了'), ...ERR_401 },
        },
      },
      '/auth/me': {
        get: {
          tags: ['auth'],
          summary: '現在のユーザを取得',
          operationId: 'getMe',
          responses: {
            '200': json('現在のユーザ(未ログイン時は null)', s.User.nullable()),
          },
        },
      },
      '/auth/init-password': {
        post: {
          tags: ['auth'],
          summary: 'パスワード初期化(初回ログイン時)',
          operationId: 'initPassword',
          security: [],
          requestBody: { content: { 'application/json': { schema: s.PasswordInitRequest } } },
          responses: { '204': noContent('初期化完了'), ...ERR_400, ...ERR_401 },
        },
      },

      // ── 3. templates ──
      '/templates/options': {
        get: {
          tags: ['templates'],
          summary: 'カスケードドロップダウンの候補を取得',
          operationId: 'getDropdownOptions',
          requestParams: { query: s.DropdownQuery },
          responses: { '200': json('各属性の候補', s.DropdownOptions), ...ERR_401 },
        },
      },
      '/templates': {
        get: {
          tags: ['templates'],
          summary: 'テンプレート一覧(属性で絞り込み)',
          operationId: 'listTemplates',
          requestParams: { query: s.DropdownQuery },
          responses: {
            '200': json('テンプレート meta の配列', z.array(s.TemplateMeta)),
            ...ERR_401,
          },
        },
      },
      '/templates/series': {
        get: {
          tags: ['templates'],
          summary: '系列ファンドのテンプレート一覧',
          operationId: 'listSeriesFunds',
          requestParams: { query: s.SeriesFundsQuery },
          responses: {
            '200': json('系列ファンドの meta 配列', z.array(s.TemplateMeta)),
            ...ERR_400,
            ...ERR_401,
          },
        },
      },
      [toOpenApiPath(apiPaths.templateById)]: {
        get: {
          tags: ['templates'],
          summary: 'テンプレート(meta + html + css)を取得',
          operationId: 'getTemplate',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '200': json('テンプレート', s.Template), ...ERR_401, ...ERR_404 },
        },
      },
      [toOpenApiPath(apiPaths.templateDraft)]: {
        get: {
          tags: ['templates'],
          summary: '常時オートセーブの下書きを取得',
          operationId: 'getDraft',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: {
            '200': json('下書き(無ければ null)', s.TemplateDraft.nullable()),
            ...ERR_401,
          },
        },
        put: {
          tags: ['templates'],
          summary: '下書きを保存(オートセーブ)',
          operationId: 'saveDraft',
          requestParams: { path: z.object({ id: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.SaveDraftRequest } } },
          responses: { '204': noContent('保存完了'), ...ERR_400, ...ERR_401 },
        },
        delete: {
          tags: ['templates'],
          summary: '下書きを破棄(確定保存せずメニューへ戻る時)',
          operationId: 'discardDraft',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '204': noContent('破棄完了(冪等)'), ...ERR_401 },
        },
      },
      '/generate': {
        post: {
          tags: ['templates'],
          summary: '新規テンプレートを生成(Python ジェネレータ)',
          operationId: 'generate',
          requestBody: { content: { 'application/json': { schema: s.GenerateRequest } } },
          responses: {
            '200': json('生成結果', s.GenerateResult),
            ...ERR_400,
            ...ERR_401,
            ...ERR_500,
          },
        },
      },
      [toOpenApiPath(apiPaths.fundSampleData)]: {
        get: {
          tags: ['templates'],
          summary: 'プレビュー用サンプルデータ(fundCode ごと)',
          operationId: 'getSampleData',
          requestParams: { path: z.object({ fundCode: z.string() }) },
          responses: { '200': json('サンプルデータ', s.SampleData), ...ERR_401, ...ERR_404 },
        },
      },

      // ── 4. parts ──
      '/parts/classification-options': {
        get: {
          tags: ['parts'],
          summary: 'パーツ分類のカスケード候補',
          operationId: 'getPartClassificationOptions',
          requestParams: { query: s.PartClassificationQuery },
          responses: { '200': json('各段階の候補', s.PartClassificationOptions), ...ERR_401 },
        },
      },
      '/parts': {
        get: {
          tags: ['parts'],
          summary: 'パーツ一覧(分類で絞り込み)',
          operationId: 'listParts',
          requestParams: { query: s.PartClassificationQuery },
          responses: {
            '200': json('パーツの配列', z.array(s.PartCatalogItem)),
            ...ERR_401,
          },
        },
      },
      [toOpenApiPath(apiPaths.partHistory)]: {
        get: {
          tags: ['parts'],
          summary: 'パーツ単位の編集履歴(版インスタンス単位の全件)',
          operationId: 'listPartHistory',
          requestParams: {
            path: z.object({ templateId: z.string() }),
          },
          responses: {
            '200': json('パーツ履歴の配列', z.array(s.PartHistoryEntry)),
            ...ERR_401,
            ...ERR_404,
          },
        },
        post: {
          tags: ['parts'],
          summary: 'パーツ単位の編集を記録',
          operationId: 'recordPartChange',
          requestParams: {
            path: z.object({ templateId: z.string() }),
          },
          requestBody: { content: { 'application/json': { schema: s.RecordPartChangeRequest } } },
          responses: { '204': noContent('記録完了'), ...ERR_400, ...ERR_401 },
        },
      },

      // ── 5. notes ──
      [toOpenApiPath(apiPaths.notes)]: {
        get: {
          tags: ['notes'],
          summary: 'パーツ単位メモを取得(版インスタンス単位の全件)',
          operationId: 'listNotes',
          requestParams: { path: z.object({ templateId: z.string() }) },
          responses: {
            '200': json('メモの配列', z.array(s.PartNote)),
            ...ERR_401,
            ...ERR_404,
          },
        },
        put: {
          tags: ['notes'],
          summary: 'パーツ単位メモを保存(content 空文字は削除)',
          operationId: 'saveNote',
          requestParams: { path: z.object({ templateId: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.SaveNoteRequest } } },
          responses: { '204': noContent('保存完了'), ...ERR_400, ...ERR_401 },
        },
      },

      // ── 5b. reviews (確定保存の精査者承認) ──
      [toOpenApiPath(apiPaths.reviewRequests)]: {
        get: {
          tags: ['reviews'],
          summary: '承認キュー一覧(approver|admin は全件、editor は自分の申請のみ)',
          operationId: 'listReviews',
          requestParams: { query: s.ReviewListQuery },
          responses: { '200': json('申請メタの配列', z.array(s.ReviewRequestMeta)), ...ERR_401 },
        },
        post: {
          tags: ['reviews'],
          summary: '確定保存を申請(pending 作成・実ファイル非更新)',
          operationId: 'submitReview',
          requestBody: { content: { 'application/json': { schema: s.SubmitReviewBody } } },
          responses: {
            '200': json('作成された申請メタ', s.ReviewRequestMeta),
            ...ERR_400,
            ...ERR_401,
            ...ERR_404,
          },
        },
      },
      [toOpenApiPath(apiPaths.reviewRequestById)]: {
        get: {
          tags: ['reviews'],
          summary: '申請詳細(本体込み・承認画面のプレビュー用)',
          operationId: 'getReview',
          requestParams: { path: z.object({ reqId: z.string() }) },
          responses: { '200': json('申請(本体込み)', s.ReviewRequest), ...ERR_401, ...ERR_404 },
        },
      },
      [toOpenApiPath(apiPaths.reviewRequestApprove)]: {
        post: {
          tags: ['reviews'],
          summary: '承認して実ファイルへ反映 + git commit(精査者限定)',
          operationId: 'approveReview',
          requestParams: { path: z.object({ reqId: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.ReviewDecisionBody } } },
          responses: {
            '200': json('反映後のテンプレート meta + 並行性警告', s.ApproveReviewResult),
            ...ERR_400,
            ...ERR_401,
            ...ERR_403,
            ...ERR_404,
            ...ERR_409,
            ...ERR_500,
          },
        },
      },
      [toOpenApiPath(apiPaths.reviewRequestReject)]: {
        post: {
          tags: ['reviews'],
          summary: '却下(精査者限定・実ファイル非更新)',
          operationId: 'rejectReview',
          requestParams: { path: z.object({ reqId: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.ReviewDecisionBody } } },
          responses: {
            '200': json('却下後の申請メタ', s.ReviewRequestMeta),
            ...ERR_400,
            ...ERR_401,
            ...ERR_403,
            ...ERR_404,
            ...ERR_409,
          },
        },
      },

      // ── 6. history ──
      '/history/edit': {
        get: {
          tags: ['history'],
          summary: '編集履歴フィード',
          operationId: 'getEditHistory',
          responses: { '200': json('編集履歴', z.array(s.EditHistoryEntry)), ...ERR_401 },
        },
      },
      '/history/pdf': {
        get: {
          tags: ['history'],
          summary: 'PDF 出力履歴フィード',
          operationId: 'getPdfHistory',
          responses: { '200': json('PDF 履歴', z.array(s.PdfHistoryEntry)), ...ERR_401 },
        },
        post: {
          tags: ['history'],
          summary: 'PDF 出力を記録',
          operationId: 'recordPdfExport',
          requestBody: { content: { 'application/json': { schema: s.RecordPdfExportRequest } } },
          responses: { '204': noContent('記録完了'), ...ERR_400, ...ERR_401 },
        },
      },
      '/history/create': {
        get: {
          tags: ['history'],
          summary: '作成履歴フィード',
          operationId: 'getCreateHistory',
          responses: { '200': json('作成履歴', z.array(s.CreateHistoryEntry)), ...ERR_401 },
        },
      },
      [toOpenApiPath(apiPaths.templateVersions)]: {
        get: {
          tags: ['history'],
          summary: 'スナップショットを持つ確定バージョン一覧(新しい順)',
          operationId: 'listVersions',
          requestParams: { path: z.object({ templateId: z.string() }) },
          responses: {
            '200': json('バージョン meta の配列', z.array(s.TemplateVersionMeta)),
            ...ERR_401,
            ...ERR_404,
          },
        },
      },
      [toOpenApiPath(apiPaths.snapshotById)]: {
        get: {
          tags: ['history'],
          summary: '確定スナップショット(凍結された HTML/CSS)を取得',
          operationId: 'getSnapshot',
          requestParams: { path: z.object({ historyId: z.string() }) },
          responses: {
            '200': json('スナップショット', s.TemplateSnapshot),
            ...ERR_401,
            ...ERR_404,
          },
        },
      },

      // ── 7. vivliostyle ──
      '/build': {
        post: {
          tags: ['vivliostyle'],
          summary: 'インライン HTML+CSS から PDF を生成',
          operationId: 'buildInline',
          requestBody: { content: { 'application/json': { schema: s.BuildInlineRequest } } },
          responses: {
            '200': {
              description: 'PDF バイナリ',
              content: { 'application/pdf': { schema: PdfBinary } },
            },
            ...ERR_400,
            ...ERR_401,
            ...ERR_500,
          },
        },
      },
      '/build/project': {
        post: {
          tags: ['vivliostyle'],
          summary: 'vivliostyle プロジェクト(zip)から PDF を生成',
          operationId: 'buildProject',
          description:
            'リクエストボディに project zip を `application/zip` で送信。' +
            'zip 内に `vivliostyle.config.*` があればそれを、無ければ単一エントリを使う。' +
            '任意クエリ: `entry`, `size`, `singleDoc`。',
          requestBody: {
            content: { 'application/zip': { schema: PdfBinary } },
          },
          responses: {
            '200': {
              description: 'PDF バイナリ',
              content: { 'application/pdf': { schema: PdfBinary } },
            },
            ...ERR_400,
            ...ERR_401,
            '413': err('プロジェクトが大きすぎる (kind=validation)'),
            ...ERR_500,
          },
        },
      },
      '/preview': {
        get: {
          tags: ['vivliostyle'],
          summary: '稼働中のプレビューセッション一覧',
          operationId: 'listPreviews',
          responses: { '200': json('セッション一覧', s.PreviewSessionList), ...ERR_401 },
        },
        post: {
          tags: ['vivliostyle'],
          summary: 'ライブプレビューを起動 (inline JSON または project zip)',
          operationId: 'startPreview',
          description:
            'inline は `application/json` (BuildInlineRequest)、project は `application/zip`。' +
            '返却 `url` (`/api/preview/{id}/`) を同一オリジンで開くと vivliostyle ビューアが表示される。',
          responses: {
            '201': json('起動したセッション', s.PreviewSession),
            ...ERR_400,
            ...ERR_401,
            ...ERR_500,
          },
        },
      },
      [toOpenApiPath(apiPaths.previewById)]: {
        get: {
          tags: ['vivliostyle'],
          summary: 'プレビューセッションのメタを取得',
          operationId: 'getPreview',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '200': json('セッション', s.PreviewSession), ...ERR_401, ...ERR_404 },
        },
        delete: {
          tags: ['vivliostyle'],
          summary: 'プレビューセッションを停止',
          operationId: 'stopPreview',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '204': noContent('停止完了'), ...ERR_401, ...ERR_404 },
        },
      },

      // ── 8. users ──
      '/users': {
        get: {
          tags: ['users'],
          summary: 'ユーザ一覧(admin 限定)',
          operationId: 'listUsers',
          responses: { '200': json('ユーザの配列', z.array(s.User)), ...ERR_401, ...ERR_403 },
        },
        post: {
          tags: ['users'],
          summary: 'ユーザ作成(admin 限定)',
          operationId: 'createUser',
          requestBody: { content: { 'application/json': { schema: s.CreateUserRequest } } },
          responses: {
            '201': json('作成されたユーザ', s.User),
            ...ERR_400,
            ...ERR_401,
            ...ERR_403,
            ...ERR_409,
          },
        },
      },
      [toOpenApiPath(apiPaths.userById)]: {
        patch: {
          tags: ['users'],
          summary: 'ユーザ部分更新(admin 限定)',
          operationId: 'updateUser',
          requestParams: { path: z.object({ id: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.UpdateUserRequest } } },
          responses: {
            '200': json('更新後のユーザ', s.User),
            ...ERR_400,
            ...ERR_401,
            ...ERR_403,
            ...ERR_404,
          },
        },
      },
      [toOpenApiPath(apiPaths.userResetPassword)]: {
        post: {
          tags: ['users'],
          summary: 'パスワードをリセット(admin 限定)',
          operationId: 'resetUserPassword',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: {
            '204': noContent('リセット完了'),
            ...ERR_401,
            ...ERR_403,
            ...ERR_404,
          },
        },
      },
    },
  });
}

/** キャッシュ済みドキュメント(初回アクセス時に一度だけ生成する)。 */
let cached: ReturnType<typeof buildOpenApiDocument> | undefined;

export function getOpenApiDocument(): ReturnType<typeof buildOpenApiDocument> {
  if (!cached) cached = buildOpenApiDocument();
  return cached;
}
