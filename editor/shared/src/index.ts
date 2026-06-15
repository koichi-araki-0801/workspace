/**
 * Shared domain & API contract types used by both `web` and `server`.
 *
 * The `web/api/local` implementation and the `server` REST implementation MUST
 * both satisfy the per-aggregate repository interfaces in
 * `./repositories/*` so the data source can be swapped without touching
 * screens/services/stores.
 */

// ---------------------------------------------------------------------------
// Domain: template identity
// ---------------------------------------------------------------------------

/** The four attributes that identify a template (filename: company_fund_date_edition.html). */
export interface TemplateAttributes {
  /** 委託会社コード */
  companyCode: string;
  /** ファンドコード */
  fundCode: string;
  /** 基準日 (yyyymmdd) */
  baseDate: string;
  /** 版種 */
  editionType: string;
}

export type TemplateStatus = 'draft' | 'published';

export interface TemplateMeta {
  /** Stable id; derived from filename without extension. */
  id: string;
  attributes: TemplateAttributes;
  /** e.g. "AM01_510037_20240710_kr.html" */
  fileName: string;
  status: TemplateStatus;
  /** ISO timestamp of last confirm-save. */
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface Template {
  meta: TemplateMeta;
  /** Raw Jinja2 HTML source (tags preserved). */
  html: string;
  /** Per-fund shared CSS (keyed by fundCode). */
  css: string;
}

/** A draft kept by the always-on autosave, separate from the confirmed file. */
export interface TemplateDraft {
  templateId: string;
  html: string;
  css: string;
  savedAt: string;
  savedBy: string;
}

// ---------------------------------------------------------------------------
// Domain: sample data (nunjucks preview context), keyed by fundCode
// ---------------------------------------------------------------------------

export type SampleData = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Domain: users / auth
// ---------------------------------------------------------------------------

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  /** Force password initialization on next login. */
  mustChangePassword: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResult {
  user: User;
  /** When true, client must route to the password-initialization screen. */
  mustChangePassword: boolean;
}

export interface PasswordInitRequest {
  username: string;
  newPassword: string;
}

// ---------------------------------------------------------------------------
// Domain: history (3 kinds shown in the history tab)
// ---------------------------------------------------------------------------

export interface EditHistoryEntry {
  id: string;
  templateId: string;
  user: string;
  timestamp: string;
  /** Human summary of what changed. */
  summary: string;
}

export interface PdfHistoryEntry {
  id: string;
  templateId: string;
  user: string;
  timestamp: string;
}

export interface CreateHistoryEntry {
  id: string;
  attributes: TemplateAttributes;
  user: string;
  timestamp: string;
  /** Template id this was generated from (series funds), if any. */
  basedOnTemplateId?: string;
}

/** Per-part (GrapesJS component) modification history, shown in the right pane. */
export interface PartHistoryEntry {
  id: string;
  templateId: string;
  /** Stable GrapesJS component id. */
  partId: string;
  user: string;
  timestamp: string;
  change: string;
}

// ---------------------------------------------------------------------------
// Domain: version snapshots (frozen HTML/CSS captured at each confirm-save,
// re-rendered on demand for the visual compare screen)
// ---------------------------------------------------------------------------

/**
 * A frozen copy of a template's content at one confirm-save, keyed by the
 * edit-history entry it belongs to. Only the source text is stored; the PDF /
 * page images are re-rendered on demand so snapshots stay small.
 */
export interface TemplateSnapshot {
  /** Matches the EditHistoryEntry.id this snapshot was captured for. */
  historyId: string;
  templateId: string;
  /** Raw Jinja2 HTML source at confirm time (tags preserved). */
  html: string;
  /** CSS at confirm time. */
  css: string;
  /** fundCode, used to fetch the sample data for re-rendering. */
  fundCode: string;
  timestamp: string;
}

/** Lightweight version-list row for the compare screen's version pickers. */
export interface TemplateVersionMeta {
  /** EditHistoryEntry.id; identifies the snapshot to load. */
  historyId: string;
  templateId: string;
  timestamp: string;
  user: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

/** Cascading-dropdown query: known attrs in, candidate options for the rest out. */
export interface DropdownQuery {
  companyCode?: string;
  fundCode?: string;
  baseDate?: string;
  editionType?: string;
}

export interface DropdownOptions {
  companyCodes: string[];
  fundCodes: string[];
  baseDates: string[];
  editionTypes: string[];
}

// ---------------------------------------------------------------------------
// Domain: parts catalog (エディタ左ペインのパーツ一覧 / 4段階の分類)
// ---------------------------------------------------------------------------

/** パーツの4段階分類。上位を選ぶと下位の候補が絞り込まれる。 */
export interface PartClassification {
  /** カテゴリ（最上位） */
  category: string;
  /** 大分類 */
  majorClass: string;
  /** 中分類 */
  middleClass: string;
  /** 小分類 */
  minorClass: string;
}

/** カタログ上の1パーツ。SQLの1行に相当する想定。 */
export interface PartCatalogItem {
  /** 安定したパーツID（SQL主キー相当）。挿入したコンポーネントの data-part-id にも使う。 */
  id: string;
  classification: PartClassification;
  /** 名称（利用者向け） */
  name: string;
  /** 説明（利用者向け） */
  description: string;
  /** 使用上の注意 */
  usageNotes: string;
  /** 最終更新日時（ISO文字列） */
  updatedAt: string | null;
  /** 最終更新者 */
  updatedBy: string | null;
  /** キャンバスに挿入するGrapesJS用HTML断片。 */
  content: string;
}

/** カスケード問い合わせ: 既知の分類を入力、残りの候補を出力。 */
export interface PartClassificationQuery {
  category?: string;
  majorClass?: string;
  middleClass?: string;
  minorClass?: string;
}

/** 各段階の候補。上位の選択で下位が絞り込まれる。 */
export interface PartClassificationOptions {
  categories: string[];
  majorClasses: string[];
  middleClasses: string[];
  minorClasses: string[];
}

/** Create tab: resolve attributes server-side and generate via the Python tool. */
export interface GenerateRequest {
  companyCode: string;
  fundCode: string;
  editionType: string;
  /** When generating from a series-fund template, base on this template. */
  basedOnTemplateId?: string;
}

export interface GenerateResult {
  template: Template;
}

export interface SaveDraftRequest {
  templateId: string;
  html: string;
  css: string;
}

export interface ConfirmSaveRequest {
  templateId: string;
  /** Restored raw Jinja2 HTML to write to the template file. */
  html: string;
  /** CSS to merge into the per-fund shared stylesheet. */
  css: string;
  fundCode: string;
}

export interface BuildInlineRequest {
  /** Already-rendered (nunjucks) HTML. */
  html: string;
  css: string;
  /** Page size handed to vivliostyle (default 'A4'). */
  size?: string;
  /** Treat the input as a single document. */
  singleDoc?: boolean;
}

// ---------------------------------------------------------------------------
// Data-access contracts: see ./repositories/* (per-aggregate, Result-returning).
// Both the web `local` and `rest` layers implement these interfaces.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-cutting: Result/error model and domain helpers (barrel re-exports)
// ---------------------------------------------------------------------------

export * from './domain/history.js';
// Template identity value object + filename helpers.
export * from './domain/template.js';
export * from './domain/user.js';
export * from './errors.js';
// Per-aggregate repository contracts (implemented by web local & REST).
export * from './repositories/AuthRepository.js';
export * from './repositories/HistoryRepository.js';
export * from './repositories/PartRepository.js';
export * from './repositories/TemplateRepository.js';
export * from './repositories/UserRepository.js';
export * from './result.js';
