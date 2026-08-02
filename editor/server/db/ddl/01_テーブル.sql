/* ============================================================================
 *  editor フェーズ2 — テーブル定義 (DDL)
 *
 *  配置: usrap.ug01 (既存 DB / 既存スキーマ。CREATE SCHEMA はしない)
 *  接頭辞: Rep1_運報自動化_Editor_  (Jinja2 側 Rep1_運報自動化_ と区別する Editor)
 *  方針:
 *    - 本文(html/css)はファイル保存。本テーブル群は台帳・カタログ・認証等のメタのみ。
 *    - 全テキストは NVARCHAR。比較に使う列(ID/コード/種別)に COLLATE Japanese_CI_AS
 *      を明示し、DB 既定照合順序に依存しない。内容/表示/パス/JSON 列は既定照合。
 *    - 時刻は DATETIME2(3) を UTC(SYSUTCDATETIME)で保管。アプリは ISO 文字列。
 *  SQL Server 2012 互換: CREATE OR ALTER / OPENJSON / FOR JSON / STRING_AGG は不使用。
 *  適用: sqlcmd -S <server> -d usrap -E -f 65001 -b -i 01_テーブル.sql  (UTF-8 BOM)
 * ==========================================================================*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

/* --- 1. テンプレート台帳 -------------------------------------------------- */
/* 「作成可能カタログ」(候補/系列の源)と生成登録のみを担う。テンプレ本体はファイル + */
/* git 側が正典。                                                                     */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_テンプレート台帳]', N'U') IS NULL
BEGIN
  CREATE TABLE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳] (
    [台帳ID]            BIGINT IDENTITY(1,1) NOT NULL,
    [テンプレートID]    NVARCHAR(128) COLLATE Japanese_CI_AS NOT NULL,
    [委託会社コード]    NVARCHAR(32)  COLLATE Japanese_CI_AS NOT NULL,
    [ファンドコード]    NVARCHAR(32)  COLLATE Japanese_CI_AS NOT NULL,
    [基準日]            NVARCHAR(8)   COLLATE Japanese_CI_AS NOT NULL,
    [版種]              NVARCHAR(16)  COLLATE Japanese_CI_AS NOT NULL,
    [ファイル名]        NVARCHAR(160) NOT NULL,
    [状態]              NVARCHAR(16)  COLLATE Japanese_CI_AS NOT NULL
                          CONSTRAINT [DF_台帳_状態] DEFAULT (N'draft'),
    [更新日時]          DATETIME2(3)  NULL,
    [更新者]            NVARCHAR(64)  NULL,
    [作成日時]          DATETIME2(3)  NOT NULL
                          CONSTRAINT [DF_台帳_作成日時] DEFAULT (SYSUTCDATETIME()),
    [論理削除]          BIT           NOT NULL
                          CONSTRAINT [DF_台帳_論理削除] DEFAULT (0),
    CONSTRAINT [PK_テンプレート台帳] PRIMARY KEY CLUSTERED ([台帳ID])
  );
END
GO

/* --- 2. ユーザー ---------------------------------------------------------- */
/* 独自認証。PW は PBKDF2 派生鍵+ソルト(VARBINARY)。ハッシュ列は API に出さない。 */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_ユーザー]', N'U') IS NULL
BEGIN
  CREATE TABLE [ug01].[Rep1_運報自動化_Editor_ユーザー] (
    [ユーザーID]        BIGINT IDENTITY(1,1) NOT NULL,
    [公開ID]            NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [ログインID]        NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [表示名]            NVARCHAR(128) NOT NULL,
    [ロール]            NVARCHAR(16)  COLLATE Japanese_CI_AS NOT NULL,
    [無効]              BIT           NOT NULL
                          CONSTRAINT [DF_ユーザー_無効] DEFAULT (0),
    [要パスワード変更]  BIT           NOT NULL
                          CONSTRAINT [DF_ユーザー_要PW変更] DEFAULT (1),
    [PWハッシュ]        VARBINARY(64) NULL,
    [PWソルト]          VARBINARY(32) NULL,
    [PW反復回数]        INT           NULL,
    [作成日時]          DATETIME2(3)  NOT NULL
                          CONSTRAINT [DF_ユーザー_作成日時] DEFAULT (SYSUTCDATETIME()),
    [更新日時]          DATETIME2(3)  NULL,
    CONSTRAINT [PK_ユーザー] PRIMARY KEY CLUSTERED ([ユーザーID])
  );
END
GO

/* --- 3. パーツカタログ --------------------------------------------------- */
/* 内容HTML は短いカタログ素材なので DB 保持(テンプレ本文ファイル方針の例外)。   */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_パーツカタログ]', N'U') IS NULL
BEGIN
  CREATE TABLE [ug01].[Rep1_運報自動化_Editor_パーツカタログ] (
    [パーツ内部ID]      BIGINT IDENTITY(1,1) NOT NULL,
    [パーツID]          NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [カテゴリ]          NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [大分類]            NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [中分類]            NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [小分類]            NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [名称]              NVARCHAR(128) NOT NULL,
    [説明]              NVARCHAR(512) NULL,
    [使用上の注意]      NVARCHAR(512) NULL,
    [内容HTML]          NVARCHAR(MAX) NOT NULL,
    [更新日時]          DATETIME2(3)  NULL,
    [更新者]            NVARCHAR(64)  NULL,
    CONSTRAINT [PK_パーツカタログ] PRIMARY KEY CLUSTERED ([パーツ内部ID])
  );
END
GO

/* 交付版⇄全体版 パーツ自動同期の種別既定(後付け列のため COL_LENGTH で冪等追加)。
 * NULL = 未判断(同期しない)。列挙値の CHECK は 03_制約.sql。ペア個別の設定は持たず、
 * ポリシーの正典はこの列のみ(同期の実行状態は dataRoot/sync の JSON がファイル側で持つ)。 */
IF COL_LENGTH(N'[ug01].[Rep1_運報自動化_Editor_パーツカタログ]', N'同期既定') IS NULL
  ALTER TABLE [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ADD [同期既定] NVARCHAR(16) COLLATE Japanese_CI_AS NULL;
GO

/* --- 4. 監査ログ --------------------------------------------------------- */
/* logger.ts の AuditEvent を列化(ファイルログとの二重化)。JSON はテキスト保管。   */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_監査ログ]', N'U') IS NULL
BEGIN
  CREATE TABLE [ug01].[Rep1_運報自動化_Editor_監査ログ] (
    [監査ID]            BIGINT IDENTITY(1,1) NOT NULL,
    [イベント]          NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [結果]              NVARCHAR(8)   COLLATE Japanese_CI_AS NOT NULL, /* success/failure */
    [実行者]            NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [IP]                NVARCHAR(64)  NULL,
    [リソースJSON]      NVARCHAR(MAX) NULL,
    [詳細JSON]          NVARCHAR(MAX) NULL,
    [エラー]            NVARCHAR(MAX) NULL,
    [発生日時]          DATETIME2(3)  NOT NULL
                          CONSTRAINT [DF_監査_発生日時] DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT [PK_監査ログ] PRIMARY KEY CLUSTERED ([監査ID])
  );
END
GO

/* --- 5. サンプルデータ --------------------------------------------------- */
/* fundCode ごとのプレビュー context(任意 JSON をテキスト保管)。               */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_サンプルデータ]', N'U') IS NULL
BEGIN
  CREATE TABLE [ug01].[Rep1_運報自動化_Editor_サンプルデータ] (
    [サンプルID]        BIGINT IDENTITY(1,1) NOT NULL,
    [ファンドコード]    NVARCHAR(32)  COLLATE Japanese_CI_AS NOT NULL,
    [データJSON]        NVARCHAR(MAX) NOT NULL,
    [更新日時]          DATETIME2(3)  NULL,
    CONSTRAINT [PK_サンプルデータ] PRIMARY KEY CLUSTERED ([サンプルID])
  );
END
GO

/* --- 6. セッション ------------------------------------------------------- */
/* cookie editor.sid。再起動でログアウトしないよう DB 保持。失効/期限で無効化。   */
IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_セッション]', N'U') IS NULL
BEGIN
  CREATE TABLE [ug01].[Rep1_運報自動化_Editor_セッション] (
    [セッションID]      NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [ログインID]        NVARCHAR(64)  COLLATE Japanese_CI_AS NOT NULL,
    [作成日時]          DATETIME2(3)  NOT NULL
                          CONSTRAINT [DF_セッション_作成日時] DEFAULT (SYSUTCDATETIME()),
    [最終アクセス]      DATETIME2(3)  NOT NULL
                          CONSTRAINT [DF_セッション_最終アクセス] DEFAULT (SYSUTCDATETIME()),
    [有効期限]          DATETIME2(3)  NOT NULL,
    [失効]              BIT           NOT NULL
                          CONSTRAINT [DF_セッション_失効] DEFAULT (0),
    CONSTRAINT [PK_セッション] PRIMARY KEY CLUSTERED ([セッションID])
  );
END
GO
