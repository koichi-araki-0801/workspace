// =============================================================================
// schemas.ts — web/server 共通 API 契約の Zod スキーマ正典 (@editor/shared/schemas)
// =============================================================================
// REST 契約(リクエスト/レスポンスのワイヤ形式)の単一正典。`api-paths.ts`(パスの正典)と
// 対をなす。server はこれを実行時リクエスト検証(`validate`/`validateQuery`)と OpenAPI
// 生成(`document.ts` の `createDocument`)の両方に使い、`index.ts` の 1:1 対応する
// TypeScript 型は `z.infer` でここから導出される(手書き二重定義は置かない)。
//
// 各スキーマは Zod 4 ネイティブの `.meta({ id })` を持ち、再利用可能な
// `#/components/schemas/<id>` として出力され、使用箇所すべてで `$ref` 参照される。
// セクション番号は `index.ts` の節構成に揃えている(並走レビューのため)。「(server 専用)」
// と記したスキーマは HTTP 固有の派生形(body/query)で、対応する shared 型を持たない。
// 意図的に型と食い違うもの(`AppError` のワイヤ形式 = `cause` 除外)は
// `test/schemas.test-d.ts` が型テストで固定する。

// zod-openapi を import すると Zod の `.meta()` 型が OpenAPI 固有フィールド
// (`id`, `param` ...)で拡張される。実行時の影響は無い。
import 'zod-openapi';
import { z } from 'zod';
import { isValidTemplateId } from './domain/template.js';
import { isValidUsername, USERNAME_MAX_LENGTH } from './domain/user.js';
import { APP_ERROR_KINDS } from './errors.js';

// ── 0. 資源上限 — 契約の段で本文の大きさを縛る ──
//
// editor は単一プロセスで、本文を同期で走査する経路(タグ走査・不変性照合・パーツ同期)が
// 複数ある。走査の計算量を直したうえで、なお**入力そのものに天井を置く**のは、天井が無い
// 契約は「グローバル `bodyLimit` だけが上限」= 経路ごとの上限引き上げがそのまま各走査の
// 上限引き上げになるためである。ここの値はテンプレ実物(数百 KB)に対して十分な余裕がある。

/** 1 文書ぶんの HTML の最大長(UTF-16 単位)。 */
export const MAX_DOCUMENT_HTML_CHARS = 4 * 1024 * 1024;
/** 1 文書ぶんの CSS の最大長(UTF-16 単位)。 */
export const MAX_DOCUMENT_CSS_CHARS = 1024 * 1024;
/** メモ 1 件の本文の最大長。 */
export const MAX_NOTE_CONTENT_CHARS = 64 * 1024;
/** メモのパーツキーの最大長(構造パスキーで、実物は数十文字)。 */
export const MAX_NOTE_PATH_KEY_CHARS = 512;

// ── 1. Template identity — テンプレート同定 ──

export const TemplateStatus = z.enum(['draft', 'published']).meta({ id: 'TemplateStatus' });

/**
 * ファイル名規約に一致し、単一のファイル名セグメントとして安全なテンプレート id。
 * ディレクトリと連結される値は契約の段でここに通す(最終的な強制は I/O 層の
 * `assertTemplateId`。二重にするのは、契約を通らない内部経路でも守るため)。
 */
export const TemplateId = z
  .string()
  .refine(isValidTemplateId, { message: '不正なテンプレート id です' })
  .meta({
    id: 'TemplateId',
    example: 'AM01_510037_20240710_交付版',
    // 制約の実体は `refine` で、JSON Schema へは `minLength` すら書き出されない。散文で
    // 添えないと、公開 OpenAPI 上は「ただの string」に見えて外部クライアントが素の文字列を
    // 送れると誤解する(`$ref` へ寄せると `minLength` のような字面上の制約は消える)。
    description:
      'ファイル名規約 `<会社コード>_<ファンドコード>_<基準日>_<版種>`(拡張子なし)。' +
      'パス区切り・`..`・制御文字・末尾のドット/空白を含まない単一のファイル名セグメントに限る' +
      '(判定は `isValidTemplateId`)。',
  });

/** テンプレートを識別する 4 属性(ファイル名: company_fund_date_edition.html)。 */
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
    filled: z.string().meta({
      description:
        'エディタキャンバス用に事前描画した filled HTML(Jinja 値を差し込みつつ元ソースを保持)。' +
        '静的な fill が無ければ空で、エディタは都度描画にフォールバックする',
    }),
  })
  .meta({ id: 'Template' });

/** 常時オンの自動保存が保持する下書き。確定ファイルとは別物。 */
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

export const UserRole = z.enum(['admin', 'approver', 'editor', 'viewer']).meta({
  id: 'UserRole',
  description:
    'admin = 全権 / approver = 精査者(確定保存の承認) / editor = 編集者(申請のみ) / viewer = 閲覧',
});

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

/**
 * 自分自身のパスワード変更。`currentPassword` は所有証明であり省略不可 — これが無いと
 * 未認証のまま任意アカウントのパスワードを書き換えられ、`admin` の乗っ取りに直結する。
 * 本人が現行パスワードを知らない場合の復旧は、管理者によるリセット(`usersReset`)だけが経路。
 */
export const PasswordInitRequest = z
  .object({
    username: z.string(),
    currentPassword: z.string().meta({ description: '現在のパスワード(所有証明)' }),
    newPassword: z.string(),
  })
  .meta({ id: 'PasswordInitRequest' });

/**
 * 新規作成 / 管理者リセットで払い出す一時パスワード。CSPRNG 由来のランダム値で、
 * **この応答 1 回だけ**運ばれる(サーバは平文を保存も再表示もしない)。ログインID を
 * そのまま初期パスワードにする形は、ID を知る者なら誰でも未活性アカウントへ入れてしまう。
 */
export const TemporaryPassword = z.string().meta({
  id: 'TemporaryPassword',
  description: '払い出した一時パスワード(平文)。この応答でのみ返り、以後は再取得できない',
});

/** ユーザ作成の応答。作成されたユーザと、本人へ帯域外で渡す一時パスワードの対。 */
export const CreatedUser = z
  .object({
    user: User,
    temporaryPassword: TemporaryPassword,
  })
  .meta({ id: 'CreatedUser' });

/** パスワードリセットの応答。新しい一時パスワードだけを返す。 */
export const PasswordResetResult = z
  .object({
    temporaryPassword: TemporaryPassword,
  })
  .meta({ id: 'PasswordResetResult' });

/**
 * ユーザーID(ログインID)の契約。**サーバ側でも運用アルファベットを強制する。**
 *
 * `USERNAME_PATTERN` を web クライアントでしか見ないと、API を直接叩けば
 * アルファベット外の ID を持つアカウントを作れる。作られてしまうと、その ID は
 * ログイン経路の入口検査(`auth/loginId.ts` の `isOperationalLoginId`)で必ず弾かれ、
 * **ログインできないアカウント**になる。作成の段で断つのが正しい位置。
 */
export const Username = z
  .string()
  .min(1)
  .max(USERNAME_MAX_LENGTH)
  .refine(isValidUsername, { error: '半角英数字とアンダースコアのみ使用できます' })
  .meta({ id: 'Username' });

/** (server 専用) Omit<User, 'id'> — 新規ユーザ作成リクエスト。 */
export const CreateUserRequest = z
  .object({
    username: Username,
    displayName: z.string(),
    role: UserRole,
    disabled: z.boolean(),
    mustChangePassword: z.boolean(),
  })
  .meta({ id: 'CreateUserRequest' });

/** (server 専用) Partial<Omit<User, 'id'>> — ユーザ部分更新リクエスト。 */
export const UpdateUserRequest = z
  .object({
    username: Username,
    displayName: z.string(),
    role: UserRole,
    disabled: z.boolean(),
    mustChangePassword: z.boolean(),
  })
  .partial()
  .meta({ id: 'UpdateUserRequest' });

// ── 4. History — グローバル 3 フィード + パーツ単位履歴 ──

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

/** パーツ別の変更履歴。エディタ右ペインに表示する。 */
export const PartHistoryEntry = z
  .object({
    id: z.string(),
    templateId: z.string(),
    partKey: z.string().meta({
      description:
        '版を跨いで安定なパーツ構造パスキー(pageAnchor/partAnchor)。GrapesJS のコンポーネント' +
        'id は再採番され不安定なため構造キーで紐づける',
    }),
    user: z.string(),
    timestamp: z.string(),
    change: z.string(),
  })
  .meta({ id: 'PartHistoryEntry' });

/**
 * (server 専用) PDF 出力の記録ボディ。
 *
 * `templateId` を素の `z.string()` にすると、監査フィードの**消去装置**になる:
 * 記録は 1 行 1 JSON の追記で、読み側は末尾 `MAX_HISTORY_TAIL_BYTES` しか読まない。
 * つまり読み窓より長い 1 行を書くだけで、それ以前の全履歴が API の視界から落ちる
 * (`files/historyFiles.ts` の追記側上限と対で守る)。
 */
export const RecordPdfExportRequest = z
  .object({ templateId: TemplateId })
  .meta({ id: 'RecordPdfExportRequest' });

/** (server 専用) パーツ変更の記録ボディ。`templateId` はパスから取る。 */
export const RecordPartChangeRequest = z
  .object({
    partKey: z.string().min(1).meta({ description: 'パーツ構造パスキー(pageAnchor/partAnchor)' }),
    change: z.string(),
  })
  .meta({ id: 'RecordPartChangeRequest' });

// ── 5. Version snapshots — 確定保存で凍結した HTML/CSS ──

/**
 * テンプレート内容を 1 回の確定保存時点で凍結したコピー。保存するのはソーステキストのみで、
 * PDF / ページ画像は都度再描画する(snapshot を小さく保つため)。
 */
export const TemplateSnapshot = z
  .object({
    historyId: z.string().meta({ description: '対応する EditHistoryEntry.id' }),
    templateId: z.string(),
    html: z.string().meta({ description: '確定時点の生 Jinja2 HTML ソース(タグ保持)' }),
    css: z.string().meta({ description: '確定時点の CSS' }),
    fundCode: z.string().meta({ description: '再描画用のサンプルデータ取得に使う' }),
    timestamp: z.string(),
  })
  .meta({ id: 'TemplateSnapshot' });

/** 比較画面のバージョン選択用の軽量な一覧行。 */
export const TemplateVersionMeta = z
  .object({
    historyId: z.string().meta({ description: 'EditHistoryEntry.id。読み込む snapshot を識別' }),
    templateId: z.string(),
    timestamp: z.string(),
    user: z.string(),
    summary: z.string(),
  })
  .meta({ id: 'TemplateVersionMeta' });

// ── 5b. Review workflow — 確定保存の精査者承認 ──

export const ReviewStatus = z
  .enum(['pending', 'approved', 'rejected'])
  .meta({ id: 'ReviewStatus' });

export const ReviewOrigin = z.enum(['edit', 'create']).meta({
  id: 'ReviewOrigin',
  description: '編集タブ(既存編集) / 作成タブ(新規) 由来。2 系統の区別を申請に保持する',
});

/** 確定保存申請のメタ(本体 html/css を除く軽量行)。一覧・承認キューに使う。 */
export const ReviewRequestMeta = z
  .object({
    id: z.string(),
    templateId: z.string(),
    attributes: TemplateAttributes,
    fundCode: z.string(),
    origin: ReviewOrigin,
    status: ReviewStatus,
    submittedBy: z.string(),
    submittedAt: z.string(),
    reviewedBy: z.string().nullable().meta({ description: '承認/却下したユーザ。pending は null' }),
    reviewedAt: z.string().nullable(),
    comment: z.string().nullable().meta({ description: '却下理由 / 承認メモ。無ければ null' }),
    baseHash: z.string().nullable().meta({ description: '申請時点の現行版コンテンツキー' }),
  })
  .meta({ id: 'ReviewRequestMeta' });

/** 申請の本体込み(承認画面のプレビュー用)。 */
export const ReviewRequest = ReviewRequestMeta.extend({
  html: z.string().meta({ description: '確定保存しようとしている生 Jinja2 HTML' }),
  css: z.string(),
  filledHtml: z.string().optional().meta({ description: '値差込済みの成果物(任意)' }),
}).meta({ id: 'ReviewRequest' });

/**
 * 確定保存の申請ボディ。`templateId` はボディで運ぶ(POST /review-requests)。
 * `templateId` を素の文字列にすると、トークン内部に空白を持つ id
 * (`AM01 _510037_…`)が承認経路へ通ってしまう。契約の段で `TemplateId` に通す。
 */
export const SubmitReviewBody = z
  .object({
    templateId: TemplateId,
    html: z.string().max(MAX_DOCUMENT_HTML_CHARS).meta({ description: '復元済みの生 Jinja2 HTML' }),
    css: z.string().max(MAX_DOCUMENT_CSS_CHARS),
    fundCode: z.string().min(1),
    filledHtml: z.string().max(MAX_DOCUMENT_HTML_CHARS).optional(),
    origin: ReviewOrigin.meta({
      description: "申請元の経路(2 系統)。route.query.created === '1' なら 'create'",
    }),
  })
  .meta({ id: 'SubmitReviewBody' });

/** 承認/却下のボディ(任意の理由/メモ)。 */
export const ReviewDecisionBody = z
  .object({ comment: z.string().optional().meta({ description: '却下理由 / 承認メモ' }) })
  .meta({ id: 'ReviewDecisionBody' });

/** (server 専用) 承認キューの絞り込みクエリ。 */
export const ReviewListQuery = z.object({ status: ReviewStatus.optional() });

/**
 * 承認直後に走る交付版⇄全体版のパーツ自動同期の結果概要。同期はベストエフォートで、
 * 失敗しても承認自体は成立する(`error` に理由を載せて UI へ渡す)。
 */
export const PairSyncSummary = z
  .object({
    pairTemplateId: z.string().meta({ description: '同期先(ペア)のテンプレート ID' }),
    applied: z.array(z.string()).meta({ description: '転写したパーツキー(partId#n)' }),
    skipped: z
      .array(z.object({ partKey: z.string(), reason: z.string() }))
      .meta({ description: '転写しなかったパーツと理由(競合・初期差分・未判断など)' }),
    error: z.string().nullable().meta({ description: '同期処理自体の失敗理由。正常時は null' }),
  })
  .meta({ id: 'PairSyncSummary' });

/**
 * 承認直後に走る注記マスタ書き戻し(`次回反映既定`=`反映` のパーツをファンド・版種別に upsert)の
 * 結果概要。ペア同期と同じくベストエフォートで、失敗しても承認自体は成立する。
 */
export const NoteMasterReflectSummary = z
  .object({
    updated: z.array(z.string()).meta({ description: '注記マスタへ書き戻したパーツ ID' }),
    error: z.string().nullable().meta({ description: '書き戻し自体の失敗理由。正常時は null' }),
  })
  .meta({ id: 'NoteMasterReflectSummary' });

/**
 * ペア同期の現況(編集画面のバナー・要判断表示用の軽量ビュー)。未解決競合 = 自動同期を
 * 停止して人間の判断を待っているパーツ。競合の解消は「両版の内容を一致させる」ことで
 * 次回承認時に自動で消える(専用の解消 API は持たない)。
 */
export const PairSyncStatus = z
  .object({
    pairTemplateId: z
      .string()
      .nullable()
      .meta({ description: 'ペアのテンプレート ID。版種がペア対象外なら null' }),
    pairExists: z.boolean().meta({ description: 'ペア実体(ファイル)が存在するか' }),
    conflicts: z
      .array(
        z.object({
          partKey: z.string(),
          kind: z.enum(['初期差分', '両側変更']),
          detectedAt: z.string(),
        }),
      )
      .meta({ description: '未解決競合(自動同期停止中)のパーツ一覧' }),
  })
  .meta({ id: 'PairSyncStatus' });

/** 承認の結果。反映後 `meta` + 並行性警告 `staleWarning` + ペア自動同期の概要 `sync`。 */
export const ApproveReviewResult = z
  .object({
    meta: TemplateMeta,
    staleWarning: z
      .boolean()
      .meta({ description: '申請時点の現行版と承認時点の現行版が食い違ったか(上書き注意)' }),
    sync: PairSyncSummary.nullable()
      .optional()
      .meta({ description: 'ペア自動同期の結果。ペア不在・版種が対象外なら null/欠落' }),
    noteMaster: NoteMasterReflectSummary.nullable()
      .optional()
      .meta({ description: '注記マスタ書き戻しの結果。テンプレ ID 解決不能なら null/欠落' }),
  })
  .meta({ id: 'ApproveReviewResult' });

// ── 6. API DTOs — カスケードドロップダウン ──

/** カスケード型ドロップダウンの問い合わせ: 既知の属性を入力、残りの候補を出力。 */
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

/** (server 専用) `GET /templates/series` のクエリパラメータ。 */
export const SeriesFundsQuery = z.object({
  companyCode: z.string(),
  fundCode: z.string(),
  editionType: z.string(),
});

// ── 7. Parts catalog / generate / draft / confirm-save / build ──

/** パーツの 4 段階分類。上位を選ぶと下位の候補が絞り込まれる。 */
export const PartClassification = z
  .object({
    category: z.string().meta({ description: 'カテゴリ(最上位)' }),
    majorClass: z.string().meta({ description: '大分類' }),
    middleClass: z.string().meta({ description: '中分類' }),
    minorClass: z.string().meta({ description: '小分類' }),
  })
  .meta({ id: 'PartClassification' });

/** 各段階の候補。上位の選択で下位が絞り込まれる。 */
export const PartClassificationOptions = z
  .object({
    categories: z.array(z.string()),
    majorClasses: z.array(z.string()),
    middleClasses: z.array(z.string()),
    minorClasses: z.array(z.string()),
  })
  .meta({ id: 'PartClassificationOptions' });

/**
 * 交付版⇄全体版 自動同期の種別既定(パーツカタログ台帳の `同期既定` 列)。
 * `同期` = 両版に在れば承認直後に転写 / `非同期` = 意図的な二重メンテ対象 /
 * `交付版のみ`・`全体版のみ` = 版固有の宣言(相手版に無くても同期漏れ扱いしない)。
 * null(未判断)は同期しない。ポリシーの正典はこの列のみ(ペア個別オーバーライドは持たない)。
 */
export const PartSyncDefault = z
  .enum(['同期', '非同期', '交付版のみ', '全体版のみ'])
  .meta({ id: 'PartSyncDefault' });

/**
 * 承認確定パーツの注記マスタ書き戻し既定(パーツカタログ台帳の `次回反映既定` 列)。
 * `反映` = 承認直後にそのファンド・版種の注記マスタへ upsert し、次回のテンプレ新規生成時に
 * スケルトンへ適用する / `非反映` = 書き戻さない宣言。null(未判断)は反映しない(オプトイン
 * 運用。誤爆防止のため未設定は安全側へ倒す)。ポリシーの正典は `同期既定` と同じくこの列のみ。
 */
export const PartMasterReflectDefault = z
  .enum(['反映', '非反映'])
  .meta({ id: 'PartMasterReflectDefault' });

/** カタログ上の 1 パーツ。SQL の 1 行に相当する想定。 */
export const PartCatalogItem = z
  .object({
    id: z.string().meta({
      description:
        '安定したパーツ ID(SQL 主キー相当)。挿入したコンポーネントの data-part-id にも使う',
    }),
    classification: PartClassification,
    name: z.string().meta({ description: '名称(利用者向け)' }),
    description: z.string().meta({ description: '説明(利用者向け)' }),
    usageNotes: z.string().meta({ description: '使用上の注意' }),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
    content: z.string().meta({ description: 'キャンバスに挿入する GrapesJS 用 HTML 断片' }),
    syncDefault: PartSyncDefault.nullable()
      .optional()
      .meta({ description: '交付版⇄全体版 自動同期の既定。null/欠落 = 未判断(同期しない)' }),
    masterReflectDefault: PartMasterReflectDefault.nullable()
      .optional()
      .meta({ description: '注記マスタ書き戻しの既定。null/欠落 = 未判断(反映しない)' }),
  })
  .meta({ id: 'PartCatalogItem' });

/** (server 専用) カスケードするパーツ分類のクエリパラメータ(すべて任意)。 */
export const PartClassificationQuery = z.object({
  category: z.string().optional(),
  majorClass: z.string().optional(),
  middleClass: z.string().optional(),
  minorClass: z.string().optional(),
});

/**
 * パーツ単位の作業メモ(版インスタンス = templateId 単位)。パーツ構造パスキー(`pathKey`)に
 * メモ本文を紐づけ、別の基準日/版種の版へは引き継がない(版ごとに独立)。キー算出は web の
 * `partKey.ts` の `partPathKeyFor`。
 */
export const PartNote = z
  .object({
    templateId: z.string().meta({ description: '版インスタンス ID(= TemplateMeta.id)' }),
    pathKey: z.string().meta({ description: 'パーツ構造パスキー(pageAnchor/partAnchor)' }),
    content: z.string().meta({ description: 'メモ本文(空文字はメモ無し)' }),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .meta({ id: 'PartNote' });

/** (server 専用) メモ保存のボディ。`templateId` はパスから取る。`content` 空文字は削除に倒す。 */
export const SaveNoteRequest = z
  .object({
    pathKey: z
      .string()
      .min(1)
      .max(MAX_NOTE_PATH_KEY_CHARS)
      .meta({ description: 'パーツ構造パスキー(pageAnchor/partAnchor)' }),
    content: z
      .string()
      .max(MAX_NOTE_CONTENT_CHARS)
      .meta({ description: '空文字は「メモ無し」= 削除' }),
  })
  .meta({ id: 'SaveNoteRequest' });

/** 作成タブ: 属性をサーバ側で解決し、Python ツール経由で生成する。 */
export const GenerateRequest = z
  .object({
    companyCode: z.string().min(1),
    fundCode: z.string().min(1),
    editionType: z.string().min(1),
    basedOnTemplateId: z
      .string()
      .optional()
      .meta({ description: 'シリーズファンドのテンプレから生成する場合の元テンプレ ID' }),
    isRedemption: z
      .boolean()
      .optional()
      .meta({ description: '償還ファンドとして作成(特定パーツを償還用へ置換。現状はモック実装)' }),
  })
  .meta({ id: 'GenerateRequest' });

export const GenerateResult = z.object({ template: Template }).meta({ id: 'GenerateResult' });

export const SaveDraftRequest = z
  .object({
    // ファイル名規約に一致する id だけを受ける。ここが素の `z.string()` だった頃は、
    // `../templates/<確定版>` を渡すだけで承認ゲートを迂回して確定ファイルを上書きできた
    // (最終的な砦は I/O 層の `assertTemplateId` だが、契約の段で落として 400 を返す)。
    templateId: TemplateId,
    html: z.string(),
    css: z.string(),
  })
  .meta({ id: 'SaveDraftRequest' });

/** インライン build のリクエストボディ(レンダリング済み HTML + 任意 CSS → PDF)。 */
export const BuildInlineRequest = z
  .object({
    html: z
      .string()
      .min(1)
      .max(MAX_DOCUMENT_HTML_CHARS)
      .meta({ description: 'レンダリング済み(nunjucks)HTML' }),
    css: z.string().max(MAX_DOCUMENT_CSS_CHARS).default(''),
    size: z.string().optional().meta({ description: 'ページサイズ (既定 A4)', example: 'A4' }),
    singleDoc: z.boolean().optional().meta({ description: '単一ドキュメント扱い' }),
  })
  .meta({ id: 'BuildInlineRequest' });

/** 結合 build の 1 文書(レンダリング済み HTML + 任意 CSS)。 */
export const BuildMergeDocument = z
  .object({
    html: z
      .string()
      .min(1)
      .max(MAX_DOCUMENT_HTML_CHARS)
      .meta({ description: 'レンダリング済み(nunjucks)HTML' }),
    css: z.string().max(MAX_DOCUMENT_CSS_CHARS).default(''),
  })
  .meta({ id: 'BuildMergeDocument' });

/**
 * 複数文書を 1 つの PDF へ結合するリクエスト(配列順 = ページ順)。文書数上限は
 * ビルド時間(`vivliostyle.build.timeoutMs` = 120s)内に収める安全弁。
 */
export const BuildMergeRequest = z
  .object({
    documents: z
      .array(BuildMergeDocument)
      .min(1)
      .max(30)
      .meta({ description: '結合する文書。配列順に連結し通しページ番号を振る' }),
    size: z.string().optional().meta({ description: 'ページサイズ (既定 A4)', example: 'A4' }),
  })
  .meta({ id: 'BuildMergeRequest' });

/** (server 専用) ライブプレビューセッションの公開メタデータ(サーバ内部情報は露出しない)。 */
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

export const AppErrorKind = z.enum(APP_ERROR_KINDS).meta({ id: 'AppErrorKind' });

/**
 * 標準のエラーレスポンスボディ。shared の `AppError`(`errors.ts`)から `cause` を除いた
 * ワイヤ形式(`cause` はログ専用で、クライアントには決して送らない。この意図的差分は
 * `test/schemas.test-d.ts` が固定する)。
 */
export const AppError = z
  .object({
    kind: AppErrorKind,
    message: z.string().meta({ description: 'ユーザ向け(JP)。常に表示して安全' }),
    code: z.string().optional().meta({ description: "機械可読コード 例: 'USER_DISABLED'" }),
  })
  .meta({ id: 'AppError' });
