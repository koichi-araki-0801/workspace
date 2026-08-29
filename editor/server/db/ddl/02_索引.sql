/* ============================================================================
 *  editor フェーズ2 — 索引 / 一意制約 (UNIQUE は一意索引で表現)
 *  SQL Server 2012 互換。冪等(sys.indexes 存在チェック)。UTF-8 BOM。
 * ==========================================================================*/

SET NOCOUNT ON;

/* --- テンプレート台帳 ---------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_台帳_テンプレートID'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_テンプレート台帳]'))
  CREATE UNIQUE INDEX [UQ_台帳_テンプレートID]
    ON [ug01].[Rep1_運報自動化_Editor_テンプレート台帳] ([テンプレートID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_台帳_属性4'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_テンプレート台帳]'))
  CREATE UNIQUE INDEX [UQ_台帳_属性4]
    ON [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
       ([委託会社コード], [ファンドコード], [基準日], [版種]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'IX_台帳_会社_ファンド'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_テンプレート台帳]'))
  CREATE INDEX [IX_台帳_会社_ファンド]
    ON [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
       ([委託会社コード], [ファンドコード]);
GO

/* --- ユーザー ------------------------------------------------------------ */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_ユーザー_公開ID'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_ユーザー]'))
  CREATE UNIQUE INDEX [UQ_ユーザー_公開ID]
    ON [ug01].[Rep1_運報自動化_Editor_ユーザー] ([公開ID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_ユーザー_ログインID'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_ユーザー]'))
  CREATE UNIQUE INDEX [UQ_ユーザー_ログインID]
    ON [ug01].[Rep1_運報自動化_Editor_ユーザー] ([ログインID]);
GO

/* --- パーツカタログ ------------------------------------------------------ */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_パーツ_パーツID'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_パーツカタログ]'))
  CREATE UNIQUE INDEX [UQ_パーツ_パーツID]
    ON [ug01].[Rep1_運報自動化_Editor_パーツカタログ] ([パーツID]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'IX_パーツ_分類'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_パーツカタログ]'))
  CREATE INDEX [IX_パーツ_分類]
    ON [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
       ([カテゴリ], [大分類], [中分類], [小分類]);
GO

/* --- 監査ログ ------------------------------------------------------------ */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'IX_監査_発生日時'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_監査ログ]'))
  CREATE INDEX [IX_監査_発生日時]
    ON [ug01].[Rep1_運報自動化_Editor_監査ログ] ([発生日時] DESC);
GO

/* --- サンプルデータ ------------------------------------------------------ */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_サンプル_ファンドコード'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_サンプルデータ]'))
  CREATE UNIQUE INDEX [UQ_サンプル_ファンドコード]
    ON [ug01].[Rep1_運報自動化_Editor_サンプルデータ] ([ファンドコード]);
GO

/* --- 注記マスタ(仮組) ---------------------------------------------------- */
/* upsert(usp_注記マスタ `反映`)のキー。実運用テーブルへの差し替え時はキー設計ごと見直す。 */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'UQ_注記_パーツ_ファンド_版種'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_注記マスタ]'))
  CREATE UNIQUE INDEX [UQ_注記_パーツ_ファンド_版種]
    ON [ug01].[Rep1_運報自動化_Editor_注記マスタ]
       ([パーツID], [ファンドコード], [版種]);
GO

/* --- セッション ---------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'IX_セッション_ログインID'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_セッション]'))
  CREATE INDEX [IX_セッション_ログインID]
    ON [ug01].[Rep1_運報自動化_Editor_セッション] ([ログインID]);
GO

/* 掃除(@操作=N'掃除')の DELETE 述語用。失効は論理フラグなので行は単調増加し、走査対象が
   時間とともに伸びる。有効期限の範囲検索を索引で解けるようにする。 */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
  WHERE name = N'IX_セッション_有効期限'
    AND object_id = OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_セッション]'))
  CREATE INDEX [IX_セッション_有効期限]
    ON [ug01].[Rep1_運報自動化_Editor_セッション] ([有効期限]);
GO
