// =============================================================================
// schemas.ts — 共有ドメイン / API 契約型(`@editor/shared`)を写した Zod スキーマ群
// =============================================================================
// Zod 4 ネイティブの `.meta()` で OpenAPI メタデータを付与する。
//
// これらは次の両方の唯一の正典(single source of truth):
//   - ルートハンドラでの実行時リクエスト検証
//   - 生成される OpenAPI ドキュメント(`document.ts`)
//
// 各スキーマは `.meta({ id })` を持ち、再利用可能な `#/components/schemas/<id>` として
// 出力され、使用箇所すべてで `$ref` 参照される。`editor/shared/src/index.ts` の
// TypeScript 型と常に同期させること。

// zod-openapi を import すると Zod の `.meta()` 型が OpenAPI 固有フィールド
// (`id`, `param` ...)で拡張される。実行時の影響は無い。
import 'zod-openapi';
import { z } from 'zod';

// ── 1. Template identity — テンプレート同定 ──

export const TemplateStatus = z.enum(['draft', 'published']).meta({ id: 'TemplateStatus' });

export const TemplateAttributes = z
  .object({
    companyCode: z.string().meta({ description: '委託会社コード' }),
    fundCode: z.string().meta({ description: 'ファンドコード' }),
    baseDate: z.string().meta({ description: '基準日 (yyyymmdd)', example: '20240710' }),
    editionType: z.string().meta({ description: '版種' }),
  })
  .meta({ id: 'TemplateAttributes' });

export const TemplateMeta = z
  .object({
    id: z.string().meta({ description: 'ファイル名(拡張子なし)由来の安定 ID' }),
    attributes: TemplateAttributes,
    fileName: z.string().meta({ example: 'AM01_510037_20240710_kr.html' }),
    status: TemplateStatus,
    updatedAt: z.string().nullable().meta({ description: '最終確定保存の ISO タイムスタンプ' }),
    updatedBy: z.string().nullable(),
  })
  .meta({ id: 'TemplateMeta' });

export const Template = z
  .object({
    meta: TemplateMeta,
    html: z.string().meta({ description: 'Jinja2 生 HTML(タグ保持)' }),
    css: z.string().meta({ description: 'fundCode ごとの共有 CSS' }),
  })
  .meta({ id: 'Template' });

export const TemplateDraft = z
  .object({
    templateId: z.string(),
    html: z.string(),
    css: z.string(),
    savedAt: z.string(),
    savedBy: z.string(),
  })
  .meta({ id: 'TemplateDraft' });

// ── 2. Sample data — プレビュー用サンプル(nunjucks コンテキスト, fundCode をキー) ──

export const SampleData = z
  .record(z.string(), z.unknown())
  .meta({ id: 'SampleData', description: 'プレビュー用サンプルデータ(任意の JSON)' });

// ── 3. Users / auth — ユーザと認証 ──

export const UserRole = z.enum(['admin', 'editor', 'viewer']).meta({ id: 'UserRole' });

export const User = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    role: UserRole,
    disabled: z.boolean(),
    mustChangePassword: z.boolean().meta({ description: '次回ログイン時にパスワード初期化を強制' }),
  })
  .meta({ id: 'User' });

export const LoginRequest = z
  .object({
    username: z.string(),
    password: z.string(),
  })
  .meta({ id: 'LoginRequest' });

export const LoginResult = z
  .object({
    user: User,
    mustChangePassword: z
      .boolean()
      .meta({ description: 'true の場合、クライアントはパスワード初期化画面へ遷移する' }),
  })
  .meta({ id: 'LoginResult' });

export const PasswordInitRequest = z
  .object({
    username: z.string(),
    newPassword: z.string(),
  })
  .meta({ id: 'PasswordInitRequest' });

/** Omit<User, 'id'> — 新規ユーザ作成リクエスト。 */
export const CreateUserRequest = z
  .object({
    username: z.string(),
    displayName: z.string(),
    role: UserRole,
    disabled: z.boolean(),
    mustChangePassword: z.boolean(),
  })
  .meta({ id: 'CreateUserRequest' });

/** Partial<Omit<User, 'id'>> — ユーザ部分更新リクエスト。 */
export const UpdateUserRequest = z
  .object({
    username: z.string(),
    displayName: z.string(),
    role: UserRole,
    disabled: z.boolean(),
    mustChangePassword: z.boolean(),
  })
  .partial()
  .meta({ id: 'UpdateUserRequest' });

// ── 4. History — グローバル 3 フィード + パーツ単位履歴 + スナップショット ──

export const EditHistoryEntry = z
  .object({
    id: z.string(),
    templateId: z.string(),
    user: z.string(),
    timestamp: z.string(),
    summary: z.string().meta({ description: '変更内容の人間可読サマリ' }),
  })
  .meta({ id: 'EditHistoryEntry' });

export const PdfHistoryEntry = z
  .object({
    id: z.string(),
    templateId: z.string(),
    user: z.string(),
    timestamp: z.string(),
  })
  .meta({ id: 'PdfHistoryEntry' });

export const CreateHistoryEntry = z
  .object({
    id: z.string(),
    attributes: TemplateAttributes,
    user: z.string(),
    timestamp: z.string(),
    basedOnTemplateId: z.string().optional().meta({ description: '系列ファンドの元テンプレ ID' }),
  })
  .meta({ id: 'CreateHistoryEntry' });

export const PartHistoryEntry = z
  .object({
    id: z.string(),
    templateId: z.string(),
    partId: z.string().meta({ description: '安定した GrapesJS コンポーネント ID' }),
    user: z.string(),
    timestamp: z.string(),
    change: z.string(),
  })
  .meta({ id: 'PartHistoryEntry' });

export const TemplateSnapshot = z
  .object({
    historyId: z.string().meta({ description: '対応する EditHistoryEntry.id' }),
    templateId: z.string(),
    html: z.string(),
    css: z.string(),
    fundCode: z.string(),
    timestamp: z.string(),
  })
  .meta({ id: 'TemplateSnapshot' });

export const TemplateVersionMeta = z
  .object({
    historyId: z.string(),
    templateId: z.string(),
    timestamp: z.string(),
    user: z.string(),
    summary: z.string(),
  })
  .meta({ id: 'TemplateVersionMeta' });

export const RecordPdfExportRequest = z
  .object({ templateId: z.string() })
  .meta({ id: 'RecordPdfExportRequest' });

export const RecordPartChangeRequest = z
  .object({ change: z.string() })
  .meta({ id: 'RecordPartChangeRequest' });

// ── 5. Dropdown — カスケードドロップダウンの query / options ──

/** カスケードドロップダウンのクエリパラメータ(すべて任意)。 */
export const DropdownQuery = z.object({
  companyCode: z.string().optional(),
  fundCode: z.string().optional(),
  baseDate: z.string().optional(),
  editionType: z.string().optional(),
});

export const DropdownOptions = z
  .object({
    companyCodes: z.array(z.string()),
    fundCodes: z.array(z.string()),
    baseDates: z.array(z.string()),
    editionTypes: z.array(z.string()),
  })
  .meta({ id: 'DropdownOptions' });

/** `GET /templates/series` のクエリパラメータ。 */
export const SeriesFundsQuery = z.object({
  companyCode: z.string(),
  fundCode: z.string(),
  editionType: z.string(),
});

// ── 6. Parts catalog — パーツカタログ ──

export const PartClassification = z
  .object({
    category: z.string().meta({ description: 'カテゴリ(最上位)' }),
    majorClass: z.string().meta({ description: '大分類' }),
    middleClass: z.string().meta({ description: '中分類' }),
    minorClass: z.string().meta({ description: '小分類' }),
  })
  .meta({ id: 'PartClassification' });

export const PartClassificationOptions = z
  .object({
    categories: z.array(z.string()),
    majorClasses: z.array(z.string()),
    middleClasses: z.array(z.string()),
    minorClasses: z.array(z.string()),
  })
  .meta({ id: 'PartClassificationOptions' });

export const PartCatalogItem = z
  .object({
    id: z.string().meta({ description: '安定したパーツ ID(SQL 主キー相当)' }),
    classification: PartClassification,
    name: z.string(),
    description: z.string(),
    usageNotes: z.string(),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
    content: z.string().meta({ description: 'キャンバスに挿入する GrapesJS 用 HTML 断片' }),
  })
  .meta({ id: 'PartCatalogItem' });

/** カスケードするパーツ分類のクエリパラメータ(すべて任意)。 */
export const PartClassificationQuery = z.object({
  category: z.string().optional(),
  majorClass: z.string().optional(),
  middleClass: z.string().optional(),
  minorClass: z.string().optional(),
});

// ── 7. Generate / draft / confirm-save / pdf — リクエストボディ群 ──

export const GenerateRequest = z
  .object({
    companyCode: z.string().min(1),
    fundCode: z.string().min(1),
    editionType: z.string().min(1),
    basedOnTemplateId: z.string().optional(),
  })
  .meta({ id: 'GenerateRequest' });

export const GenerateResult = z.object({ template: Template }).meta({ id: 'GenerateResult' });

export const SaveDraftRequest = z
  .object({
    templateId: z.string(),
    html: z.string(),
    css: z.string(),
  })
  .meta({ id: 'SaveDraftRequest' });

/**
 * 確定保存のボディ。`templateId` はパスから取るため、ボディは内容のみを運ぶ。
 * 既存の `PUT /templates/:id` ハンドラに対応する。
 */
export const ConfirmSaveBody = z
  .object({
    html: z.string().meta({ description: '復元済みの Jinja2 生 HTML' }),
    css: z.string().meta({ description: 'fund 共有 CSS にマージする CSS' }),
    fundCode: z.string(),
  })
  .meta({ id: 'ConfirmSaveBody' });

/** `confirmSave` は更新後の `TemplateMeta` を返す(Repository 契約に対応)。 */
export const ConfirmSaveResult = TemplateMeta;

/** インライン build のリクエストボディ(レンダリング済み HTML + 任意 CSS → PDF)。 */
export const BuildInlineRequest = z
  .object({
    html: z.string().min(1).meta({ description: 'レンダリング済み(nunjucks)HTML' }),
    css: z.string().default(''),
    size: z.string().optional().meta({ description: 'ページサイズ (既定 A4)', example: 'A4' }),
    singleDoc: z.boolean().optional().meta({ description: '単一ドキュメント扱い' }),
  })
  .meta({ id: 'BuildInlineRequest' });

/** ライブプレビューセッションの公開メタデータ(サーバ内部情報は露出しない)。 */
export const PreviewSession = z
  .object({
    id: z.string().meta({ description: 'プレビューセッション ID' }),
    mode: z.enum(['inline', 'project']),
    createdAt: z.string().meta({ description: '作成時刻 (ISO)' }),
    expiresAt: z.string().meta({ description: 'アイドル失効予定時刻 (ISO)' }),
    url: z
      .string()
      .meta({ description: '同一オリジンのプレビュー URL', example: '/api/preview/{id}/' }),
  })
  .meta({ id: 'PreviewSession' });

export const PreviewSessionList = z.array(PreviewSession).meta({ id: 'PreviewSessionList' });

// ── 8. Cross-cutting — 横断的スキーマ ──

export const HealthResult = z.object({ ok: z.literal(true) }).meta({ id: 'HealthResult' });

export const AppErrorKind = z
  .enum([
    'not_found',
    'validation',
    'unauthorized',
    'forbidden',
    'conflict',
    'network',
    'unexpected',
  ])
  .meta({ id: 'AppErrorKind' });

/**
 * 標準のエラーレスポンスボディ。`@editor/shared` の `AppError` から `cause` を除いた形
 * (`cause` はログ専用で、クライアントには決して送らない)。
 */
export const AppError = z
  .object({
    kind: AppErrorKind,
    message: z.string().meta({ description: 'ユーザ向け(JP)。常に表示して安全' }),
    code: z.string().optional().meta({ description: "機械可読コード 例: 'USER_DISABLED'" }),
  })
  .meta({ id: 'AppError' });
