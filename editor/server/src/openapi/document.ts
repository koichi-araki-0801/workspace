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

/**
 * project zip の受入条件。`POST /build/project` と `POST /preview`(zip 経路)が同じ
 * `prepareProject` を通るので文面を 1 つにする。外部クライアントはまだ存在せず、**ここに
 * 書いたものがそのまま本番の契約になる**ため、実装(`vivliostyle/projectInput.ts` の
 * `ALLOWED_EXTENSIONS` / `isIgnorableEntry` / `isNpmArtifact`、`vivliostyle/projectConfig.ts`
 * の `ACCEPTED_KEYS`)と 1 対 1 に対応させ、400 の判断材料を仕様だけから導けるようにする。
 * 実装を変えたらこの文面も変えること(片方だけ動くと外部実装者が 400 の理由を導けない)。
 */
const PROJECT_ZIP_CONTRACT = [
  'リクエストボディに project zip を `application/zip` で送信する。',
  '**受理は許可リスト方式**で、1 エントリでも条件を外れた時点で zip 全体が 400 になる',
  '(該当エントリだけ無視する挙動ではない)。',
  '\n\n**展開して残せる拡張子**(小文字化した basename の末尾一致): ',
  '`.html` `.htm` `.xhtml` `.xht` `.md` `.markdown` `.css` `.css.map` ',
  '`.png` `.jpg` `.jpeg` `.svg` `.gif` `.webp` `.apng` `.ttf` `.otf` `.woff` `.woff2` `.json`。',
  'これ以外(`.js` `.mjs` `.cjs` `.ts` を含む)は 400。',
  '設定を `vivliostyle.config.js` 等で送っても「無視される」のではなく**拒否される**。',
  '\n\n**黙って捨てる OS ノイズ**(400 にはしない): `__MACOSX/**`・`.DS_Store`・',
  '`Thumbs.db`・`desktop.ini`・`._` で始まる名前。',
  '\n\n**拒否する npm 成果物**: `node_modules/` を含むパス・`package.json`・',
  '`package-lock.json`・`.npmrc`。',
  '\n\n**config は `vivliostyle.config.json` ちょうど 1 件**(名前は大小文字を無視して照合)。',
  '2 件以上あれば 400。無ければ単一エントリを既定として使う。',
  '内容は**厳密な JSON** のみで、コメント・末尾カンマ(JSONC)や配列(複数タスク)は 400。',
  '\n\n**受理するトップレベルキー**: `entry` `entryContext` `theme` `cover` `toc` `title` ',
  '`author` `language` `readingProgression` `size` `copyAsset`。',
  'これ以外はキー名を挙げて 400 になる(`output` `workspaceDir` `vfm` `image` `timeout` ',
  '`viewer` `server` `static` `pdfPostprocess` など vivliostyle CLI の正規フィールドも含む)。',
  '`base` は専用メッセージで 400 — 文書の配信先はサーバが固定する。',
  '\n\n**`theme` の制約**: 展開ルート内に実在する `.css` ファイルへの相対パスのみ。',
  '拡張子の判定は**大小文字を区別**する(`.CSS` は不可)。npm パッケージ指定子・',
  '`{specifier, import}` 形は不可。`entry` 要素ごとの `theme` にも同じ制約が掛かる。',
  '\n\n**400 応答**はすべて `kind=validation` で、`message` は日本語 1 文。',
  '拡張子違反は「取り込めるのは <許可拡張子一覧> だけです」、キー違反は',
  '「vivliostyle.config.json に指定できないキーがあります: <キー名>」のように',
  '**違反した対象を名指しする**(どのファイル・どのキーで落ちたかが応答から判る)。',
  '展開時の資源上限(ファイル数・展開後サイズ・圧縮比・目録サイズ)超過も 400 で、',
  '上限値を message に含める。413 になるのは**リクエスト本文そのもの**が',
  'サーバの `bodyLimit` を超えた場合だけ(fastify が返す)。',
  '\n\n',
].join('');

/**
 * 外部参照の禁止。build 3 本と project プレビューが同じゲート
 * (`security/externalRefs.ts`)を通るので文面を 1 つにする。外部クライアントはまだ存在せず、
 * **ここに書いたものがそのまま本番の契約になる**。
 */
const EXTERNAL_REF_CONTRACT = [
  '\n\n**外部参照は拒否する**(`code=DOCUMENT_EXTERNAL_REF` の 400)。PDF は CSP の無い headless ',
  'ブラウザで組版されるため、CSS からの取得はそのままビルドサーバの位置からの GET になる。',
  '検査対象は (1) リクエストの `css`、(2) HTML 中の `<style>` ブロック、',
  '(3) HTML の `style="…"` 属性、(4) HTML の**取得系属性**',
  '(`<link href>` `<script src>` `<img src|srcset>` `<iframe src>` `<object data>` ',
  'SVG の `href`/`xlink:href` 等。`<a href>` は組版中に取得を起こさないので対象外)、',
  '(zip 経路は加えて展開した `.css` / `.html` 全件)。',
  '拒否するのは **許可リスト外の at-rule**(`@import` `@use` 等。`@media` `@page` と',
  'マージンボックス `@bottom-center` 等は許可)と、**外部を指す URL 値**',
  '(scheme 付き・scheme 相対 `//host/x`・許可外の `data:`)で、`url()` に限らず',
  '`image-set("http://…")` のような引用符文字列も含む。許可する `data:` は ',
  '`data:image/png` `data:image/jpeg` `data:image/jpg` `data:image/gif` `data:image/webp` ',
  '`data:font/` `data:application/font-woff` の接頭辞のみ(`data:image/svg+xml` は不可)。',
  '**相対 URL と断片(`#id`)は通る。むしろ必須である** — テンプレは per-fund CSS・共通フォント・',
  'テンプレ JS を `css/…` `fonts/…` `js/…` の相対パスで参照し、サーバが配信ルートへ同梱する。',
  '同梱の実体が無い相対参照の `<link>` / `<script src>` は 400 にはせず要素ごと落とす',
  '(404 は組版のページ分割を止めるため)。**削らずに拒む**のは外部参照の方で、',
  '違反が 1 件でも PDF は生成されない。',
  'また、タグ境界が一意に決まらない HTML(閉じないタグ・コメント・`<style>`/`<script>`)は',
  '`code=DOCUMENT_UNPARSABLE` の 400 で拒む — 検査できない入力を通すとそれ自体が回避路になる。',
  '\n\n**文書内の JavaScript**: 組版時に実行される。ただし実行されるのは ',
  '**body 末尾のインライン `<script>` だけ**である(実測)。組版エンジンは文書を再パースして ',
  'script をビューアの window へ作り直すため、`<script src="js/x.js">` は相対 URL の解決基準が',
  'ずれて 404 になり、`<head>` で `DOMContentLoaded` に登録した処理も発火しない。',
  'なお組版ブラウザの **HTTP/HTTPS 通信**は、そのビルド専用の loopback オリジン 1 つだけへ',
  '中継される(それ以外は宛先が loopback でも 502 で落ちる)。',
  'ただし遮断の実体は HTTP プロキシ 1 本なので、**HTTP 以外の経路**(WebRTC の UDP 等)は',
  'この中継を通らない — そこは残余リスクとして残る。',
  '\n\n',
].join('');

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
            // 未知の ID・無効アカウント・パスワード誤りは**すべて同一の応答**(kind /
            // message / code / 応答時間)。差を作ると利用者の存在有無が読める。
            '401': err('資格情報が不正 (kind=unauthorized。存在有無は区別しない)'),
            '403': err(
              'レート制限で拒否 (kind=forbidden)。`code` は総当たり検出時 LOGIN_RATE_LIMITED、' +
                '同時実行の上限超過時 LOGIN_BUSY。前者は (IP, ログインID) または IP 単位の窓を' +
                '超えた場合で、message に待ち秒数を含む。後者は即時再試行してよい',
            ),
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
      // `security: []` は付けない。自分自身のパスワード変更であり、セッションと現行パスワードの
      // 両方を要する(未認証で開けていた頃は任意アカウントの乗っ取り経路だった)。
      '/auth/init-password': {
        post: {
          tags: ['auth'],
          summary: 'パスワード変更(本人・現行パスワードによる所有証明が必要)',
          operationId: 'initPassword',
          // `username` は**宛先として使わない**。対象は常にセッションの所有者で、食い違う
          // 指定は 403 になる(将来スキーマから外す予定のフィールド)。成功すると同一
          // ユーザーの**他の**セッションは全て失効する(操作中のセッションだけ残る)。
          requestBody: { content: { 'application/json': { schema: s.PasswordInitRequest } } },
          responses: {
            '204': noContent('変更完了(他端末のセッションは失効)'),
            ...ERR_400,
            // 認証が課されない構成でも 401 になる(ガードは設定値を参照しない)。
            ...ERR_401,
            '403': err(
              '本人以外を指定した、またはレート制限で拒否 (kind=forbidden)。' +
                '後者の `code` は login と同じ LOGIN_RATE_LIMITED / LOGIN_BUSY',
            ),
          },
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
          description:
            '確定テンプレを先に見る。無い場合だけ生成直後の未確定(pending)実体を ' +
            '`status: "draft"` で返す。順序が逆だと pending を書ける者が確定テンプレの' +
            '表示内容を差し替えられるため、確定優先は契約である。',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '200': json('テンプレート', s.Template), ...ERR_401, ...ERR_404 },
        },
      },
      [toOpenApiPath(apiPaths.templateSyncStatus)]: {
        get: {
          tags: ['templates'],
          summary: '交付版⇄全体版 ペア同期の現況(未解決競合の一覧)',
          operationId: 'getTemplateSyncStatus',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '200': json('ペア同期の現況', s.PairSyncStatus), ...ERR_401 },
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
          description: [
            '生成物は**未確定(pending)領域**に置かれ、確定テンプレのディレクトリには書かれない。',
            '直後は `GET /templates/{id}` が `status: "draft"` で返り、`GET /templates` の一覧には',
            '現れない(一覧は承認済みの確定テンプレのみ)。確定への昇格は承認',
            '(`POST /review-requests` → `.../approve`)だけが行う。',
            '会社コード・ファンドコード・版種は 1 トークンとして安全な文字列に限る',
            '(`/` `` `_` `..` 制御文字・前後空白・末尾ドットは 400)。',
          ].join(''),
          requestBody: { content: { 'application/json': { schema: s.GenerateRequest } } },
          responses: {
            '200': json('生成結果(meta.status は draft)', s.GenerateResult),
            ...ERR_400,
            ...ERR_401,
            '409': err('同じ属性の確定テンプレートが既にある (kind=conflict)'),
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
          requestBody: { content: { 'application/json': { schema: s.ReviewRejectBody } } },
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
      [toOpenApiPath(apiPaths.reviewRequestHold)]: {
        post: {
          tags: ['reviews'],
          summary: '保留(精査者限定・実ファイル非更新)',
          operationId: 'holdReview',
          requestParams: { path: z.object({ reqId: z.string() }) },
          requestBody: { content: { 'application/json': { schema: s.ReviewDecisionBody } } },
          responses: {
            '200': json('保留後の申請メタ', s.ReviewRequestMeta),
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
          requestParams: {
            path: z.object({ historyId: z.string() }),
            query: z.object({
              templateId: z
                .string()
                .optional()
                .meta({ description: 'その版のどのテンプレを取り出すか(複数含む版では必須)' }),
            }),
          },
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
          description: EXTERNAL_REF_CONTRACT,
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
            `${PROJECT_ZIP_CONTRACT}任意クエリ: \`entry\`, \`size\`, \`singleDoc\`。` +
            EXTERNAL_REF_CONTRACT,
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
      '/build/merge': {
        post: {
          tags: ['vivliostyle'],
          summary: '複数のレンダリング済み文書を 1 つの PDF へ結合',
          operationId: 'buildMerge',
          description:
            '`documents` の配列順に連結し、全体で通しページ番号を振った 1 つの PDF を返す。' +
            EXTERNAL_REF_CONTRACT,
          requestBody: { content: { 'application/json': { schema: s.BuildMergeRequest } } },
          responses: {
            '200': {
              description: 'PDF バイナリ',
              content: { 'application/pdf': { schema: PdfBinary } },
            },
            ...ERR_400,
            ...ERR_401,
            '413': err('リクエストが大きすぎる (kind=validation)'),
            ...ERR_500,
          },
        },
      },
      '/preview': {
        get: {
          tags: ['vivliostyle'],
          summary: '稼働中のプレビューセッション一覧(自分が作成した分のみ)',
          operationId: 'listPreviews',
          description:
            'セッションは作成した利用者に紐づく。admin 以外は自分が作成したセッションだけが返る。',
          responses: { '200': json('セッション一覧', s.PreviewSessionList), ...ERR_401 },
        },
        post: {
          tags: ['vivliostyle'],
          summary: 'ライブプレビューを起動 (inline JSON または project zip)',
          operationId: 'startPreview',
          description:
            'inline は `application/json` (BuildInlineRequest)、project は `application/zip`。' +
            '返却 `url` (`/api/preview/{id}/`) を同一オリジンで開くと vivliostyle ビューアが表示される。' +
            '\n\nzip 経路の受入条件は `POST /build/project` と**同一**である(同じ展開・検証を通る):' +
            '\n\n' +
            PROJECT_ZIP_CONTRACT,
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
          description: '他人が作成したセッションは 404(存在を漏らさないため 403 にしない)。',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '200': json('セッション', s.PreviewSession), ...ERR_401, ...ERR_404 },
        },
        delete: {
          tags: ['vivliostyle'],
          summary: 'プレビューセッションを停止',
          operationId: 'stopPreview',
          description: '他人が作成したセッションは 404(停止も作業ディレクトリ削除も起きない)。',
          requestParams: { path: z.object({ id: z.string() }) },
          responses: { '204': noContent('停止完了'), ...ERR_401, ...ERR_404 },
        },
      },
      [`${toOpenApiPath(apiPaths.previewById)}/{path}`]: {
        get: {
          tags: ['vivliostyle'],
          summary: 'プレビュー資産の中継(リバースプロキシ)',
          operationId: 'proxyPreviewAsset',
          description: [
            'プレビューセッションのビューアと文書を同一オリジンで配信する中継。',
            '**GET / HEAD のみ**を受け付ける(他メソッドは 404)。',
            '中継されるのは次の 2 系統だけで、それ以外はすべて 404 になり上流へは到達しない:',
            '`/__vivliostyle-viewer/**`(ビューアアプリ資産)と、',
            '**サーバが固定する** `/vivliostyle/**`(文書の配信先)。',
            'この配信先は `vivliostyle.config.json` の `base` では変えられない',
            '(`base` の指定自体が 400 になる)。',
            'したがって Vite の内部エンドポイント(`/@fs`・`/@id`・`/node_modules`・',
            '`/__open-in-editor`)は利用できない。percent-encoding で偽装した形も、',
            '生と復号後の双方で照合するため通らない。',
            '他人が作成したセッションの id を指定した場合も 404。',
          ].join(''),
          requestParams: { path: z.object({ id: z.string(), path: z.string() }) },
          responses: {
            '200': { description: '上流プレビューサーバの応答をそのまま返す' },
            ...ERR_401,
            '404': err(
              'セッションが無い / 他人のセッション / 配信対象外のパス (kind=not_found)。' +
                '配信対象外のパスと存在しないセッションは区別しない。',
            ),
            '502': err('プレビューサーバに接続できない (kind=network)'),
          },
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
            // 応答は `User` 単体ではなく `{ user, temporaryPassword }`。初期パスワードを
            // ログインID と同じにする設計をやめた結果、払い出した平文をここでしか運べない
            // (サーバは保存も再表示もしない)。外部クライアントは `user` を 1 段掘ること。
            '201': json('作成されたユーザと一時パスワード', s.CreatedUser),
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
            // 新しい一時パスワードを運ぶため 204 ではなく 200 + ボディ。
            '200': json('新しい一時パスワード', s.PasswordResetResult),
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
