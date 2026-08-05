// =============================================================================
// index.ts — web/server 共通のドメイン型と API 契約型 (barrel)
// =============================================================================
// `web/api/local` 実装と `server` の REST 実装は、いずれも `./repositories/*` の
// 集約別リポジトリ interface を満たさねばならない。これによりデータソースを
// 画面/サービス/ストアに触れず差し替えできる。
//
// API 契約型(ワイヤ形式)の正典は `./schemas.ts` の Zod スキーマで、1:1 対応する型は
// `z.infer` で導出する(S7 で手書き二重定義を廃止。フィールドの説明は schemas 側に置く)。
// Zod に対応物が無い型(UI ヘルパ・派生形)のみ、従来どおり interface で手書きする。

// 型導出専用の type-only import。ビルド(tsc)/バンドル(Vite)で消去されるため、web の
// 実行時バンドルに zod は入らない。
import type { z } from 'zod';
import type * as sch from './schemas.js';

// ── 1. Domain: template identity ──

/** テンプレートを識別する4属性 (ファイル名: company_fund_date_edition.html)。 */
export type TemplateAttributes = z.infer<typeof sch.TemplateAttributes>;

export type TemplateStatus = z.infer<typeof sch.TemplateStatus>;

export type TemplateMeta = z.infer<typeof sch.TemplateMeta>;

/** テンプレ本体。`filled` はエディタ用の事前描画 HTML(無ければ空 = 都度描画に fallback)。 */
export type Template = z.infer<typeof sch.Template>;

/** 常時オンの自動保存が保持する下書き。確定ファイルとは別物。 */
export type TemplateDraft = z.infer<typeof sch.TemplateDraft>;

// ── 2. Domain: sample data (nunjucks プレビュー文脈)。fundCode をキーにする ──

export type SampleData = z.infer<typeof sch.SampleData>;

// ── 3. Domain: users / auth ──

// admin = 全権 / approver = 精査者(確定保存の承認) / editor = 編集者(申請のみ) / viewer = 閲覧。
// 確定保存(実ファイル反映)は approver|admin の承認が要る(`ReviewRepository` を見よ)。
export type UserRole = z.infer<typeof sch.UserRole>;

export type User = z.infer<typeof sch.User>;

export type LoginRequest = z.infer<typeof sch.LoginRequest>;

/** `mustChangePassword` が true のとき、クライアントはパスワード初期化画面へ遷移する。 */
export type LoginResult = z.infer<typeof sch.LoginResult>;

export type PasswordInitRequest = z.infer<typeof sch.PasswordInitRequest>;

/**
 * ユーザ作成の応答。`temporaryPassword` は払い出しの 1 回だけ運ばれる平文で、管理者が
 * 画面で読み取り本人へ帯域外(口頭・紙)で渡す。保存も再表示もできない。
 */
export type CreatedUser = z.infer<typeof sch.CreatedUser>;

/** 管理者によるパスワードリセットの応答。新しい一時パスワードのみを運ぶ。 */
export type PasswordResetResult = z.infer<typeof sch.PasswordResetResult>;

// ── 4. Domain: history (履歴タブに表示する3種) ──

export type EditHistoryEntry = z.infer<typeof sch.EditHistoryEntry>;

export type PdfHistoryEntry = z.infer<typeof sch.PdfHistoryEntry>;

export type CreateHistoryEntry = z.infer<typeof sch.CreateHistoryEntry>;

/** パーツ別の変更履歴。右ペインに表示する(パスキー算出は web の `partKey.ts`)。 */
export type PartHistoryEntry = z.infer<typeof sch.PartHistoryEntry>;

// ── 5. Domain: version snapshots ──
// 各確定保存で凍結した HTML/CSS を捕捉し、比較画面では都度再描画する。

/**
 * テンプレート内容を 1 回の確定保存時点で凍結したコピー。属する編集履歴エントリ
 * (`historyId` = `EditHistoryEntry.id`)をキーにする。
 */
export type TemplateSnapshot = z.infer<typeof sch.TemplateSnapshot>;

/** 比較画面のバージョン選択用の、軽量なバージョン一覧行。 */
export type TemplateVersionMeta = z.infer<typeof sch.TemplateVersionMeta>;

// ── 5b. Domain: review workflow (確定保存の精査者承認) ──
// 確定保存(= 実ファイル `data/templates` + git への反映)を「申請(submit)」と
// 「承認(approve)」の 2 段に割る。申請は実ファイルを更新せず `data/reviews/` に積み、
// approver|admin が承認したときに限り実ファイルへ反映する。編集タブ(既存編集)・作成タブ
// (新規確定)の両経路を一律にゲートする。詳細は `repositories/ReviewRepository.ts` を見よ。

export type ReviewStatus = z.infer<typeof sch.ReviewStatus>;

/** 確定保存申請のメタデータ(本文 html/css を除く軽量行)。一覧・承認キューに使う。 */
export type ReviewRequestMeta = z.infer<typeof sch.ReviewRequestMeta>;

/** 申請の本体込み(承認画面のプレビュー・承認反映に使う)。 */
export type ReviewRequest = z.infer<typeof sch.ReviewRequest>;

/**
 * 確定保存の申請ボディ。`PreviewView` が editor/approver いずれの操作でも積む。
 * HTTP 上のスキーマ名は `SubmitReviewBody`(POST /review-requests)。
 */
export type SubmitReviewRequest = z.infer<typeof sch.SubmitReviewBody>;

/**
 * 承認/却下のボディ。`comment` は却下理由 / 承認メモ(任意)。
 * HTTP 上のスキーマ名は `ReviewDecisionBody`。
 */
export type ReviewDecisionRequest = z.infer<typeof sch.ReviewDecisionBody>;

/**
 * 承認の結果。`meta` は実ファイルへ反映後のテンプレメタ。`staleWarning` は申請時点の現行版
 * (`baseHash`)と承認時点の現行版が食い違っていたか(= 申請後に別の確定保存が割り込んだ)を表す。
 * true でも承認自体はブロックせず、承認者へ「上書きに注意」を促す警告フラグとして UI に渡す。
 */
export type ApproveReviewResult = z.infer<typeof sch.ApproveReviewResult>;

/**
 * 承認直後に走る交付版⇄全体版のパーツ自動同期の結果概要。承認応答(`ApproveReviewResult.sync`)
 * に載せて UI へ渡す。同期の実装は server の `sync/partSync.ts`、ポリシーの正典はパーツ
 * カタログ台帳の `同期既定` 列(`PartSyncDefault`)。
 */
export type PairSyncSummary = z.infer<typeof sch.PairSyncSummary>;

/** ペア同期の現況(編集画面のバナー用軽量ビュー。未解決競合の一覧を運ぶ)。 */
export type PairSyncStatus = z.infer<typeof sch.PairSyncStatus>;

/**
 * 承認直後に走る注記マスタ書き戻しの結果概要。承認応答(`ApproveReviewResult.noteMaster`)に
 * 載せて UI へ渡す。実装は server の `sync/noteMasterService.ts`、ポリシーの正典はパーツ
 * カタログ台帳の `次回反映既定` 列(`PartMasterReflectDefault`)。
 */
export type NoteMasterReflectSummary = z.infer<typeof sch.NoteMasterReflectSummary>;

// ── 6. API DTOs ──

/** カスケード型ドロップダウンの問い合わせ: 既知の属性を入力、残りの候補を出力。 */
export type DropdownQuery = z.infer<typeof sch.DropdownQuery>;

export type DropdownOptions = z.infer<typeof sch.DropdownOptions>;

// ── 7. Domain: parts catalog (エディタ左ペインのパーツ一覧 / 4段階の分類) ──

/** パーツの4段階分類。上位を選ぶと下位の候補が絞り込まれる。 */
export type PartClassification = z.infer<typeof sch.PartClassification>;

/** カタログ上の1パーツ。SQLの1行に相当する想定。 */
export type PartCatalogItem = z.infer<typeof sch.PartCatalogItem>;

/** 交付版⇄全体版 自動同期の種別既定(カタログ台帳の `同期既定` 列)。null は未判断。 */
export type PartSyncDefault = z.infer<typeof sch.PartSyncDefault>;

/** 注記マスタ書き戻しの既定(カタログ台帳の `次回反映既定` 列)。null は未判断(反映しない)。 */
export type PartMasterReflectDefault = z.infer<typeof sch.PartMasterReflectDefault>;

/**
 * パーツ単位の作業メモ(版インスタンス単位)。`templateId`(= 委託会社/ファンドコード/基準日/
 * 版種の4属性を内包する版インスタンス)配下で、パーツ構造パスキー(`pathKey`)にメモ本文を
 * 紐づける。別の基準日/版種の版へは引き継がない(版ごとに独立)。キー算出は `web` の
 * `partKey.ts` の `partPathKeyFor`。
 */
export type PartNote = z.infer<typeof sch.PartNote>;

/** カスケード問い合わせ: 既知の分類を入力、残りの候補を出力。 */
export type PartClassificationQuery = z.infer<typeof sch.PartClassificationQuery>;

/** 各段階の候補。上位の選択で下位が絞り込まれる。 */
export type PartClassificationOptions = z.infer<typeof sch.PartClassificationOptions>;

/** 作成タブ: 属性をサーバ側で解決し、Python ツール経由で生成する。 */
export type GenerateRequest = z.infer<typeof sch.GenerateRequest>;

/** ファンドの属性解決の結果 (例: シリーズファンドか否か)。 */
export interface FundResolution {
  /** 属性解決の結果、シリーズファンド（コアラップ系）と判定できたか。 */
  isSeriesFund: boolean;
}

export type GenerateResult = z.infer<typeof sch.GenerateResult>;

export type SaveDraftRequest = z.infer<typeof sch.SaveDraftRequest>;

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

/**
 * インライン build のリクエスト。スキーマの output 型を採るため `css` は必須
 * (ワイヤ上は `css` 省略可で、サーバ側 validate が `default('')` で補完する)。
 */
export type BuildInlineRequest = z.infer<typeof sch.BuildInlineRequest>;

/** 結合 build の 1 文書。`css` の扱いは `BuildInlineRequest` と同じ(validate が補完)。 */
export type BuildMergeDocument = z.infer<typeof sch.BuildMergeDocument>;

/** 複数文書 → 1 PDF の結合 build リクエスト(配列順 = ページ順)。 */
export type BuildMergeRequest = z.infer<typeof sch.BuildMergeRequest>;

// ── 8. Data-access contracts ──
// 集約別・Result を返す契約は `./repositories/*` を参照。web の `local` 層と `rest`
// 層がいずれもこれらの interface を実装する。

// ── 9. Cross-cutting: Result/エラーモデルとドメインヘルパ (barrel 再エクスポート) ──

// REST エンドポイントパスの単一正典(server/web/OpenAPI が共有)。
export * from './api-paths.js';
export * from './domain/history.js';
// 承認ワークフローの純関数(メタ抽出)。
export * from './domain/review.js';
// パーツ別共通ダミー + ファンド固有マスタ合成(プレビュー文脈の組立)。
export * from './domain/sampleCommon.js';
export * from './domain/sampleData.js';
// テンプレート identity の値オブジェクト + ファイル名ヘルパ。
export * from './domain/template.js';
export * from './domain/user.js';
export * from './errors.js';
// 集約別のリポジトリ契約 (web local と REST が実装)。
export * from './repositories/AuthRepository.js';
export * from './repositories/HistoryRepository.js';
export * from './repositories/NoteRepository.js';
export * from './repositories/PartRepository.js';
export * from './repositories/ReviewRepository.js';
export * from './repositories/TemplateRepository.js';
export * from './repositories/UserRepository.js';
export * from './result.js';
// CSS の外部参照検出。関門はサーバ(build 入口)に置き、web は同じ関数を早期表示に使う。
export * from './security/cssExternalRefs.js';
// HTML 属性値の正規化(文字参照の復号 + URL パーサ相当の空白除去)。判定の手前で必ず通す。
export * from './security/htmlEntities.js';
// HTML 属性の外部参照検出。同梱資産への相対参照は通し、オリジン外の絶対参照だけを拒む。
export * from './security/htmlExternalRefs.js';
