/**
 * Zod schemas that mirror the shared domain & API-contract types
 * (`@editor/shared`), annotated with OpenAPI metadata via Zod 4's native
 * `.meta()`.
 *
 * These are the SINGLE SOURCE OF TRUTH for both:
 *   - runtime request validation in the route handlers, and
 *   - the generated OpenAPI document (`./document.ts`).
 *
 * Each schema carries `.meta({ id })` so it is emitted as a reusable
 * `#/components/schemas/<id>` entry and referenced by `$ref` everywhere it is
 * used. Keep these in lockstep with the TypeScript types in
 * `editor/shared/src/index.ts`.
 */

// Importing zod-openapi augments Zod's `.meta()` typings with OpenAPI-specific
// fields (`id`, `param`, ...). No runtime effect.
import 'zod-openapi';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Template identity
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sample data (nunjucks preview context, keyed by fundCode)
// ---------------------------------------------------------------------------

export const SampleData = z
  .record(z.string(), z.unknown())
  .meta({ id: 'SampleData', description: 'プレビュー用サンプルデータ(任意の JSON)' });

// ---------------------------------------------------------------------------
// Users / auth
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// History (3 global feeds + per-part history + snapshots)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dropdown (cascading) query/options
// ---------------------------------------------------------------------------

/** Query params for the cascading dropdowns (all optional). */
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

/** Query params for `GET /templates/series`. */
export const SeriesFundsQuery = z.object({
  companyCode: z.string(),
  fundCode: z.string(),
  editionType: z.string(),
});

// ---------------------------------------------------------------------------
// Parts catalog
// ---------------------------------------------------------------------------

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

/** Query params for the cascading parts classification (all optional). */
export const PartClassificationQuery = z.object({
  category: z.string().optional(),
  majorClass: z.string().optional(),
  middleClass: z.string().optional(),
  minorClass: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Generate / draft / confirm-save / pdf request bodies
// ---------------------------------------------------------------------------

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
 * Confirm-save body. `templateId` is taken from the path, so the body carries
 * only the content. Matches the existing `PUT /templates/:id` handler.
 */
export const ConfirmSaveBody = z
  .object({
    html: z.string().meta({ description: '復元済みの Jinja2 生 HTML' }),
    css: z.string().meta({ description: 'fund 共有 CSS にマージする CSS' }),
    fundCode: z.string(),
  })
  .meta({ id: 'ConfirmSaveBody' });

/** confirmSave returns the updated TemplateMeta (matches the repository contract). */
export const ConfirmSaveResult = TemplateMeta;

/** Inline build request body (rendered HTML + optional CSS → PDF). */
export const BuildInlineRequest = z
  .object({
    html: z.string().min(1).meta({ description: 'レンダリング済み(nunjucks)HTML' }),
    css: z.string().default(''),
    size: z.string().optional().meta({ description: 'ページサイズ (既定 A4)', example: 'A4' }),
    singleDoc: z.boolean().optional().meta({ description: '単一ドキュメント扱い' }),
  })
  .meta({ id: 'BuildInlineRequest' });

/** A live-preview session's public metadata (no server internals exposed). */
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

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

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
 * Standard error response body. Mirrors `@editor/shared`'s `AppError` minus
 * `cause` (which is log-only and never sent to clients).
 */
export const AppError = z
  .object({
    kind: AppErrorKind,
    message: z.string().meta({ description: 'ユーザ向け(JP)。常に表示して安全' }),
    code: z.string().optional().meta({ description: "機械可読コード 例: 'USER_DISABLED'" }),
  })
  .meta({ id: 'AppError' });
