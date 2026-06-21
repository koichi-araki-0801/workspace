// =============================================================================
// index.ts — web/server 共通のドメイン型と API 契約型 (barrel)
// =============================================================================
// `web/api/local` 実装と `server` の REST 実装は、いずれも `./repositories/*` の
// 集約別リポジトリ interface を満たさねばならない。これによりデータソースを
// 画面/サービス/ストアに触れず差し替えできる。

// ── 1. Domain: template identity ──

/** テンプレートを識別する4属性 (ファイル名: company_fund_date_edition.html)。 */
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
  /** 安定 id。拡張子を除いたファイル名から導出する。 */
  id: string;
  attributes: TemplateAttributes;
  /** 例 "AM01_510037_20240710_kr.html" */
  fileName: string;
  status: TemplateStatus;
  /** 最後の確定保存の ISO タイムスタンプ。 */
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface Template {
  meta: TemplateMeta;
  /** 生の Jinja2 HTML ソース (タグは保持)。 */
  html: string;
  /** ファンド別の共有 CSS (fundCode をキーにする)。 */
  css: string;
  /**
   * エディタキャンバス用に事前描画した "filled" HTML: Jinja 値を差し込みつつ、元の
   * `{{ }}`/`{% %}` ソースを保持したもの (`fillJinja.toFilled` 参照)。静的な fill が
   * 無ければ空で、エディタは都度描画にフォールバックする。
   */
  filled: string;
}

/** 常時オンの自動保存が保持する下書き。確定ファイルとは別物。 */
export interface TemplateDraft {
  templateId: string;
  html: string;
  css: string;
  savedAt: string;
  savedBy: string;
}

// ── 2. Domain: sample data (nunjucks プレビュー文脈)。fundCode をキーにする ──

export type SampleData = Record<string, unknown>;

// ── 3. Domain: users / auth ──

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  /** 次回ログイン時にパスワード初期化を強制する。 */
  mustChangePassword: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResult {
  user: User;
  /** true のとき、クライアントはパスワード初期化画面へ遷移しなければならない。 */
  mustChangePassword: boolean;
}

export interface PasswordInitRequest {
  username: string;
  newPassword: string;
}

// ── 4. Domain: history (履歴タブに表示する3種) ──

export interface EditHistoryEntry {
  id: string;
  templateId: string;
  user: string;
  timestamp: string;
  /** 変更内容の人間向け要約。 */
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
  /** これを生成した元テンプレ id (シリーズファンド由来)。あれば。 */
  basedOnTemplateId?: string;
}

/** パーツ (GrapesJS コンポーネント) 別の変更履歴。右ペインに表示する。 */
export interface PartHistoryEntry {
  id: string;
  templateId: string;
  /** 安定した GrapesJS コンポーネント id。 */
  partId: string;
  user: string;
  timestamp: string;
  change: string;
}

// ── 5. Domain: version snapshots ──
// 各確定保存で凍結した HTML/CSS を捕捉し、比較画面では都度再描画する。

/**
 * テンプレート内容を 1 回の確定保存時点で凍結したコピー。属する編集履歴エントリを
 * キーにする。保存するのはソーステキストのみで、PDF / ページ画像は都度再描画する
 * (snapshot を小さく保つため)。
 */
export interface TemplateSnapshot {
  /** この snapshot を捕捉した対象の `EditHistoryEntry.id` に一致する。 */
  historyId: string;
  templateId: string;
  /** 確定時点の生 Jinja2 HTML ソース (タグは保持)。 */
  html: string;
  /** 確定時点の CSS。 */
  css: string;
  /** fundCode。再描画用のサンプルデータ取得に使う。 */
  fundCode: string;
  timestamp: string;
}

/** 比較画面のバージョン選択用の、軽量なバージョン一覧行。 */
export interface TemplateVersionMeta {
  /** `EditHistoryEntry.id`。読み込む snapshot を識別する。 */
  historyId: string;
  templateId: string;
  timestamp: string;
  user: string;
  summary: string;
}

// ── 6. API DTOs ──

/** カスケード型ドロップダウンの問い合わせ: 既知の属性を入力、残りの候補を出力。 */
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

// ── 7. Domain: parts catalog (エディタ左ペインのパーツ一覧 / 4段階の分類) ──

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

/** 作成タブ: 属性をサーバ側で解決し、Python ツール経由で生成する。 */
export interface GenerateRequest {
  companyCode: string;
  fundCode: string;
  editionType: string;
  /** シリーズファンドのテンプレから生成する場合、このテンプレを基にする。 */
  basedOnTemplateId?: string;
  /**
   * 償還ファンドとして作成する。true のとき作成済みテンプレの特定パーツを
   * 償還用パーツへ置換する（現状はモック実装）。
   */
  isRedemption?: boolean;
}

/** ファンドの属性解決の結果 (例: シリーズファンドか否か)。 */
export interface FundResolution {
  /** 属性解決の結果、シリーズファンド（コアラップ系）と判定できたか。 */
  isSeriesFund: boolean;
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
  /** テンプレファイル (ファンド別テンプレ) に書き戻す、復元済みの生 Jinja2 HTML。 */
  html: string;
  /** ファンド別の共有スタイルシートへマージする CSS。 */
  css: string;
  fundCode: string;
  /**
   * 描画済みの "filled" ドキュメント (値差込済み・Jinja なし)。この確定の帳票
   * インスタンスとして保持する。任意。描画対象が無ければ省略する。
   */
  filledHtml?: string;
}

/** 確定済みの帳票インスタンス: テンプレと並べて保存する filled ドキュメント。 */
export interface TemplateInstance {
  templateId: string;
  html: string;
  css: string;
  savedAt: string;
  savedBy: string;
}

export interface BuildInlineRequest {
  /** 既に描画済み (nunjucks) の HTML。 */
  html: string;
  css: string;
  /** vivliostyle へ渡すページサイズ (既定 'A4')。 */
  size?: string;
  /** 入力を単一ドキュメントとして扱う。 */
  singleDoc?: boolean;
}

// ── 8. Data-access contracts ──
// 集約別・Result を返す契約は `./repositories/*` を参照。web の `local` 層と `rest`
// 層がいずれもこれらの interface を実装する。

// ── 9. Cross-cutting: Result/エラーモデルとドメインヘルパ (barrel 再エクスポート) ──

export * from './domain/history.js';
// テンプレート identity の値オブジェクト + ファイル名ヘルパ。
export * from './domain/template.js';
export * from './domain/user.js';
export * from './errors.js';
// 集約別のリポジトリ契約 (web local と REST が実装)。
export * from './repositories/AuthRepository.js';
export * from './repositories/HistoryRepository.js';
export * from './repositories/PartRepository.js';
export * from './repositories/TemplateRepository.js';
export * from './repositories/UserRepository.js';
export * from './result.js';
