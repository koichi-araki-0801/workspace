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
import { isValidAnyTemplateId } from './domain/template.js';
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
/** 1 パーツが保持できる投稿数の上限。件数上限だけではファイル上限を守れないため両方持つ。 */
export const MAX_NOTE_ENTRIES_PER_PART = 200;
/**
 * メモ 1 ファイル(1 版インスタンス)が保持できる `pathKey` の件数上限(パーツ数の実物は
 * 1 版あたり数十)。web の local 実装(`api/local/noteRepo.ts`)と server 実装
 * (`server/src/files/notesFile.ts`)の双方が同じ値を強制する必要があるため shared に置く —
 * 複製すると片方だけが追随しない値の乖離を構造的に作る。
 */
export const MAX_NOTES_PER_TEMPLATE = 1000;

// ── 1. Template identity — テンプレート同定 ──

export const TemplateStatus = z.enum(['draft', 'published']).meta({ id: 'TemplateStatus' });

/**
 * ファイル名規約に一致し、単一のファイル名セグメントとして安全なテンプレート id。
 * ディレクトリと連結される値は契約の段でここに通す(最終的な強制は I/O 層の
 * `assertAnyTemplateId`。二重にするのは、契約を通らない内部経路でも守るため)。
 */
export const TemplateId = z
  .string()
  .refine(isValidAnyTemplateId, { message: '不正なテンプレート id です' })
  .meta({
    id: 'TemplateId',
    example: 'AM01_510037_20240710_交付版',
    // 制約の実体は `refine` で、JSON Schema へは `minLength` すら書き出されない。散文で
    // 添えないと、公開 OpenAPI 上は「ただの string」に見えて外部クライアントが素の文字列を
    // 送れると誤解する(`$ref` へ寄せると `minLength` のような字面上の制約は消える)。
    description:
      'ファイル名規約(拡張子なし)。値入り HTML は `<会社コード>_<ファンドコード>_<基準日>_<版種>`、' +
      'テンプレートは `<会社コード>_<ファンドコード>_<版種>`。' +
      'パス区切り・`..`・制御文字・末尾のドット/空白を含まない単一のファイル名セグメントに限る' +
      '(判定は `isValidAnyTemplateId`)。',
  });

/**
 * テンプレートを識別する属性。値入り HTML は 4 つ(company_fund_date_edition.html)、
 * テンプレートは基準日を除く 3 つ(company_fund_edition.html)。
 */
export const TemplateAttributes = z
  .object({
    companyCode: z
      .string()
      .meta({ description: '委託会社(ファイル名の会社コード = Rep1 の委託会社略称)' }),
    fundCode: z.string().meta({ description: 'ファンドコード' }),
    baseDate: z.string().optional().meta({
      description:
        '基準日(yyyymmdd または yyyy-mm-dd)。値入り HTML(filled/)だけが持ち、テンプレート(templates/)は持たない',
      example: '2024-05-17',
    }),
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
    css: z.string().meta({
      description: 'テンプレ単位の CSS(css/<会社>_<ファンド>_<版種>.css。基準日違いの文書で共有)',
    }),
    filled: z.string().meta({
      description:
        'エディタキャンバス用に事前描画した filled HTML(Jinja 値を差し込みつつ元ソースを保持)。' +
        '静的な fill が無ければ空で、エディタは都度描画にフォールバックする',
    }),
    cssMissing: z
      .boolean()
      .optional()
      .meta({
        description:
          '確定版の CSS ファイル(css/<会社>_<ファンド>_<版種>.css)が見つからないとき true。' +
          'あれば付けない。生成直後(pending)は pending の CSS ファイルが無いとき true',
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
    id: z.string().meta({ description: '一覧の行 id。`<historyId>:<templateId>` で行ごとに一意' }),
    historyId: z
      .string()
      .meta({ description: '版(コミット)の識別子。snapshot 取得・版比較はこちらを使う' }),
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
    basedOnTemplateId: z
      .string()
      .optional()
      .meta({ description: '過去の履歴(シリーズの元テンプレ ID)。新しい履歴は sourceFundCode' }),
    sourceFundCode: z
      .string()
      .optional()
      .meta({ description: 'シリーズから作成したときのコピー元ファンドコード' }),
  })
  .meta({ id: 'CreateHistoryEntry' });

/** パーツ別の変更履歴。エディタ右ペインに表示する。 */
export const PartHistoryEntry = z
  .object({
    id: z.string(),
    templateId: z.string(),
    partKey: z.string().meta({
      description:
        '版を跨いで安定なパーツ構造キー(文書全体でのアンカー#通し番号)。GrapesJS のコンポーネント' +
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
    partKey: z
      .string()
      .min(1)
      .meta({ description: 'パーツ構造キー(文書全体でのアンカー#通し番号)' }),
    change: z.string(),
    id: z
      .uuid()
      .optional()
      .meta({ description: '履歴 1 件の id(web が採番。重複表示の除去に使う)' }),
  })
  .meta({ id: 'RecordPartChangeRequest' });

// ── 5. Version snapshots — 確定保存で凍結した HTML/CSS ──

/**
 * テンプレート内容を 1 回の確定保存時点で凍結したコピー。保存するのはソーステキストのみで、
 * PDF / ページ画像は都度再描画する(snapshot を小さく保つため)。
 */
export const TemplateSnapshot = z
  .object({
    historyId: z.string().meta({ description: '対応する `EditHistoryEntry.historyId`' }),
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
    historyId: z
      .string()
      .meta({ description: 'EditHistoryEntry.historyId。読み込む snapshot を識別' }),
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

/**
 * 申請時に申請者ブラウザが計算した変更概要(パーツ数と業務名)。一覧の先出し表示専用の
 * **参考情報**で、承認判断には使わない — 承認は精査画面がその場で計算する実差分に基づく。
 * 申請者由来の自己申告値であることを消費側は前提にする(改竄されても表示が変わるだけ)。
 */
export const ReviewChangedSummary = z
  .object({
    count: z.number().int().min(0),
    names: z.array(z.string().max(200)).max(50),
  })
  .meta({ id: 'ReviewChangedSummary' });

/** 確定保存申請のメタ(本体 html/css を除く軽量行)。申請一覧の表示に使う。 */
export const ReviewRequestMeta = z
  .object({
    id: z.string(),
    templateId: z.string(),
    attributes: TemplateAttributes,
    origin: ReviewOrigin,
    status: ReviewStatus,
    submittedBy: z.string(),
    submittedAt: z.string(),
    reviewedBy: z.string().nullable().meta({ description: '承認/却下したユーザ。pending は null' }),
    reviewedAt: z.string().nullable(),
    comment: z.string().nullable().meta({ description: '却下理由 / 承認メモ。無ければ null' }),
    baseHash: z.string().nullable().meta({ description: '申請時点の現行版コンテンツキー' }),
    changedSummary: ReviewChangedSummary.nullable().optional(),
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
    filledHtml: z.string().max(MAX_DOCUMENT_HTML_CHARS).optional(),
    cssBaseline: z.string().max(MAX_DOCUMENT_CSS_CHARS).optional().meta({
      description:
        '確定版の CSS を `css` と同じ書き出しの形にしたもの。無ければ承認時のペアへの CSS 転写を飛ばす',
    }),
    origin: ReviewOrigin.meta({
      description: "申請元の経路(2 系統)。route.query.created === '1' なら 'create'",
    }),
    changedSummary: ReviewChangedSummary.optional().meta({
      description: '申請者側で計算した変更概要(参考表示用の自己申告)',
    }),
  })
  .meta({ id: 'SubmitReviewBody' });

/** 承認/却下のボディ(任意の理由/メモ)。 */
export const ReviewDecisionBody = z
  .object({ comment: z.string().optional().meta({ description: '承認メモ / 保留メモ(任意)' }) })
  .meta({ id: 'ReviewDecisionBody' });

/**
 * 却下の決定。`comment` だけは必須にする(空白のみも受け付けない)。却下された申請者にとって
 * ここが「何を直せばよいか」を知る唯一の欄であり、監査ログに残る判断の根拠でもある。
 * 画面側で入力を必須にするだけでは、API を直接叩く経路が素通りする。
 * 承認・保留のメモを必須にはしない(通すだけの承認で無意味な文字列を書かせることになる)。
 */
export const ReviewRejectBody = z
  .object({ comment: z.string().trim().min(1).meta({ description: '却下理由(必須)' }) })
  .meta({ id: 'ReviewRejectBody' });

/** (server 専用) 申請一覧の絞り込みクエリ。 */
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
    css: z
      .object({
        applied: z.array(z.string()).meta({ description: 'ペアの CSS へ写した規則のキー' }),
        conflicts: z
          .array(z.string())
          .meta({ description: 'ペア側が承認前と違うため写さなかった規則のキー' }),
      })
      .nullable()
      .meta({ description: 'CSS の転写結果。承認で CSS が変わらなかったときは null' }),
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
 * 停止して人間の判断を待っているパーツと CSS 規則。競合の解消は「両版の内容を一致させる」か
 * 「先行変更した側を承認して逆方向の転写を走らせる」ことで次回承認時に自動で消える
 * (専用の解消 API は持たない)。
 */
/** ペア同期でパーツ 1 件に記録する競合の種類。状態ファイルの検査と API 応答で共有する。 */
export const PAIR_PART_CONFLICT_KINDS = [
  '初期差分',
  '両側変更',
  'ペア側先行',
  'ペア側削除',
  'ペア側削除・ソース変更',
] as const;

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
          kind: z.enum(PAIR_PART_CONFLICT_KINDS),
          detectedAt: z.string(),
          deletedIn: z
            .string()
            .optional()
            .meta({ description: 'ペア側削除系の競合で、パーツを消した側の版種(交付版 / 全体版)' }),
        }),
      )
      .meta({ description: '未解決競合(自動同期停止中)のパーツ一覧' }),
    cssConflicts: z
      .array(
        z.object({
          ruleKey: z.string(),
          detectedAt: z.string(),
          kind: z
            .enum(['照合不可'])
            .optional()
            .meta({ description: '規則を相手側の規則と照合できず転写を止めたときの種類' }),
          sourceEdition: z
            .string()
            .optional()
            .meta({ description: '変更を持っていた側(転写元)の版種' }),
        }),
      )
      .meta({
        description:
          '未解決の CSS 規則の競合(ペア側が版種固有に直してある、または照合できず転写を止めた規則)',
      }),
  })
  .meta({ id: 'PairSyncStatus' });

/** 承認の結果。反映後 `meta` + 並行性警告 `staleWarning` + ペア自動同期の概要 `sync`。 */
export const ApproveReviewResult = z
  .object({
    meta: TemplateMeta,
    staleWarning: z.boolean().meta({
      description:
        '申請時点の現行版と承認時点の現行版が食い違ったか(上書き注意。CSS は基準日をまたいで共有されるため、他の基準日の承認による変更も含む)',
    }),
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

/** 候補の出所。edit = filled/ + pending/、published = filled/ のみ。 */
export const DROPDOWN_SCOPES = ['edit', 'published'] as const;
export const DropdownScope = z.enum(DROPDOWN_SCOPES);

/** `GET /templates/options` のクエリ。`scope` 省略時は `edit`。 */
export const DropdownOptionsQuery = DropdownQuery.extend({
  scope: DropdownScope.optional(),
});

export const DropdownOptions = z
  .object({
    companyCodes: z.array(z.string()),
    fundCodes: z.array(z.string()),
    baseDates: z.array(z.string()),
    editionTypes: z.array(z.string()),
  })
  .meta({ id: 'DropdownOptions' });

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
    targetEdition: z.string().nullable().optional().meta({
      description:
        '対象の版種。null/欠落 = 両版共通。一覧の絞り込み表示だけに使い、同期は syncDefault で決める',
    }),
  })
  .meta({ id: 'PartCatalogItem' });

/** (server 専用) カスケードするパーツ分類のクエリパラメータ(すべて任意)。 */
export const PartClassificationQuery = z.object({
  category: z.string().optional(),
  majorClass: z.string().optional(),
  middleClass: z.string().optional(),
  minorClass: z.string().optional(),
  editionType: z
    .string()
    .optional()
    .meta({ description: 'テンプレートの版種。指定時は対象版種が空か一致するパーツだけ' }),
});

/** コメントの状態。返信は親と同じ値を持ち、切り替えは親投稿にだけ許す。 */
export const NoteStatus = z.enum(['open', 'resolved']).meta({ id: 'NoteStatus' });

/**
 * パーツ単位コメントの投稿 1 件。コメントは 1 段の入れ子を持つスレッドで、投稿は書かれた
 * 版インスタンスのファイルへ入る(交付版⇄全体版で共有しない)。
 * `templateId` は投稿が属する版(編集・削除の宛先)。キー算出は web の `partKey.ts`。
 */
export const PartNoteEntry = z
  .object({
    id: z.string().meta({ description: '投稿 ID(UUID)' }),
    templateId: z.string().meta({ description: '投稿が属する版インスタンス ID' }),
    pathKey: z.string().meta({ description: 'パーツ構造キー(文書全体でのアンカー#通し番号)' }),
    content: z.string().meta({ description: '投稿本文' }),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string().nullable().meta({ description: '本文が編集された場合のみ' }),
    updatedBy: z.string().nullable(),
    status: NoteStatus.meta({ description: '未対応 / 解決済み。返信は親と同じ値' }),
    replyTo: z
      .string()
      .nullable()
      .meta({ description: '親投稿の ID。null なら親(スレッドの起点)' }),
  })
  .meta({ id: 'PartNoteEntry' });

/**
 * (server 専用) 投稿の追加。`templateId` はパスから取る。空文字の本文は受け付けない。
 * `replyTo` は同じパーツの親投稿を指す(親の検証はサーバの `noteRepo` が行う)。
 */
export const AddNoteRequest = z
  .object({
    pathKey: z
      .string()
      .min(1)
      .max(MAX_NOTE_PATH_KEY_CHARS)
      .meta({ description: 'パーツ構造キー(文書全体でのアンカー#通し番号)' }),
    content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS).meta({ description: '投稿本文' }),
    replyTo: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .meta({ description: '返信先の親投稿 ID。null なら親投稿として追加する' }),
  })
  .meta({ id: 'AddNoteRequest' });

/**
 * (server 専用) 投稿の部分更新。本文と状態のどちらか一方以上を指定する。削除は DELETE で
 * 明示するため、本文の空文字は受け付けない。状態は親投稿にだけ指定できる(返信への指定は
 * サーバが拒否する)。
 */
export const UpdateNoteRequest = z
  .object({
    content: z
      .string()
      .min(1)
      .max(MAX_NOTE_CONTENT_CHARS)
      .optional()
      .meta({ description: '投稿本文' }),
    status: NoteStatus.optional(),
  })
  .refine((b) => b.content !== undefined || b.status !== undefined, {
    message: '本文か状態のどちらかを指定してください',
  })
  .meta({ id: 'UpdateNoteRequest' });

// ── 作成タブ: 委託会社・ファンド・作成可否(Rep1 のファンド属性 + ファイル) ──

export const CompanyOption = z
  .object({
    companyCode: z.string().meta({ description: 'ファイル名の会社コード(Rep1 の委託会社略称)' }),
    companyName: z.string().meta({ description: '委託会社名' }),
    rep1CompanyCode: z
      .string()
      .meta({ description: 'Rep1 の委託会社コード(ファンドを引くときに使う)' }),
  })
  .meta({ id: 'CompanyOption' });

export const FundOption = z
  .object({ fundCode: z.string(), fundName: z.string() })
  .meta({ id: 'FundOption' });

export const SeriesFundOption = FundOption.extend({
  hasTemplate: z.boolean().meta({
    description:
      'コピー元のテンプレート(templates/<会社>_<ファンド>_<版種>.html。基準日なし)があるか',
  }),
}).meta({ id: 'SeriesFundOption' });

export const CreatableInfo = z
  .object({
    created: z.boolean().meta({
      description:
        '選んだ会社・ファンド・版種のテンプレートが templates/ にあるか(会社_ファンド_版種.html。大文字小文字は区別しない)',
    }),
    templateId: z.string().optional().meta({
      description:
        '作成済みのときのテンプレートの id(templates/ のファイルの綴りのまま)。作成タブの「既存のテンプレートを開く」で開く',
    }),
    inProgressId: z
      .string()
      .optional()
      .meta({
        description:
          '作成済みでなく、同じ id の下書きか pending/ があるときの id。作成タブの「作成中のテンプレートを開く」で開く。' +
          '作り直すときは確認のうえ GenerateRequest.replaceExisting を付ける',
      }),
    seriesFunds: z
      .array(SeriesFundOption)
      .meta({ description: '同じシリーズの他のファンド(シリーズから作成のコピー元候補)' }),
  })
  .meta({ id: 'CreatableInfo' });

export const FundsQuery = z.object({ rep1CompanyCode: z.string().min(1).max(32) });

export const CreatableQuery = z.object({
  companyCode: z.string().min(1),
  rep1CompanyCode: z.string().min(1).max(32),
  fundCode: z.string().min(1),
  editionType: z.string().min(1),
});

/** 作成タブ: 属性をサーバ側で解決し、Python ツール経由で生成する。 */
export const GenerateRequest = z
  .object({
    companyCode: z.string().min(1),
    fundCode: z.string().min(1),
    editionType: z.string().min(1),
    sourceFundCode: z.string().optional().meta({
      description: 'シリーズから作成するときのコピー元ファンドコード(会社と版種は作成先と同じ)',
    }),
    isRedemption: z
      .boolean()
      .optional()
      .meta({ description: '償還ファンドとして作成(生成器へパラメータとして渡す)' }),
    replaceExisting: z.boolean().optional().meta({
      description:
        '同じ id の下書き・pending/ を捨てて作り直すことへの同意。無いまま作業中のものがあれば 409',
    }),
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
    singleDoc: z.boolean().optional().meta({
      description:
        '受け付けるが無視する(inline の build と preview は entry 1 本の config で、既に単一文書として組む)',
    }),
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

/** 画像の確認 API が 1 回に受け付ける参照の上限(1 文書の画像は実物で数枚〜十数枚)。 */
export const MAX_FUND_ASSET_INSPECT_REFS = 50;

/** 画像の参照 1 件。`dir` は会社フォルダ(`images/` 直下なら null)。 */
export const FundAssetRef = z
  .object({
    dir: z.string().max(255).nullable().meta({ description: '会社フォルダ(直下なら null)' }),
    file: z.string().max(255).meta({ description: 'ファイル名' }),
  })
  .meta({ id: 'FundAssetRef' });

/** 画像が配信されるかの確認(配信ルートと同じ判定。ファイルの中身は返さない)。 */
export const FundAssetInspectRequest = z
  .object({ refs: z.array(FundAssetRef).max(MAX_FUND_ASSET_INSPECT_REFS) })
  .meta({ id: 'FundAssetInspectRequest' });

/**
 * 1 件の判定。`missing` は配信対象外(存在しない・経路が不正・許可外の拡張子)をまとめたもので、
 * どれに当たったかは返さない — 画像の置き場の外にある名前の有無を確かめる手段にしない。
 */
export const FundAssetInspectResult = FundAssetRef.extend({
  status: z.enum(['ok', 'missing', 'svg_rejected']),
  violations: z
    .array(z.string())
    .optional()
    .meta({ description: '`svg_rejected` のときだけ。SVG の検査の違反の文言' }),
}).meta({ id: 'FundAssetInspectResult' });

export const FundAssetInspectResponse = z
  .object({ results: z.array(FundAssetInspectResult) })
  .meta({ id: 'FundAssetInspectResponse' });

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
