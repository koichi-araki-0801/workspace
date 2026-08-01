/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_テンプレート
 *  @操作 で分岐: 候補 / 系列 / 生成登録
 *  台帳は「作成可能カタログ」(候補/系列の源)と生成登録のみを担う。既存テンプレの
 *  一覧/取得・確定保存・下書き・版/スナップはファイル + git 側へ移行済み(本 sproc 対象外)。
 *  SQL Server 2012 互換: CREATE OR ALTER 不可 → DROP+CREATE。UTF-8 BOM。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_テンプレート]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_テンプレート];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_テンプレート]
  @操作              NVARCHAR(32),
  @テンプレートID    NVARCHAR(128) = NULL,
  @委託会社コード    NVARCHAR(32)  = NULL,
  @ファンドコード    NVARCHAR(32)  = NULL,
  @基準日            NVARCHAR(8)   = NULL,
  @版種              NVARCHAR(16)  = NULL,
  @ファイル名        NVARCHAR(160) = NULL
AS
BEGIN
  SET NOCOUNT ON;

  /* ---- 候補: カスケードドロップダウン(1 結果セット, 区分で判別) ---------- */
  IF @操作 = N'候補'
  BEGIN
    ;WITH t AS (
      SELECT [委託会社コード], [ファンドコード], [基準日], [版種]
        FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
        WHERE [論理削除] = 0
    )
    SELECT [区分], [値] FROM (
      SELECT N'会社' AS [区分], [委託会社コード] AS [値] FROM t
      UNION
      SELECT N'ファンド', [ファンドコード] FROM t
        WHERE (@委託会社コード IS NULL OR [委託会社コード] = @委託会社コード)
      UNION
      -- 各候補は「自分より上位の選択」だけで絞る(自分自身・下位は含めない)。そうしないと
      -- 版種を選んだ後にその版種だけへ候補が潰れ、別の版種(例: 全体版)へ戻せない。
      SELECT N'基準日', [基準日] FROM t
        WHERE (@委託会社コード IS NULL OR [委託会社コード] = @委託会社コード)
          AND (@ファンドコード IS NULL OR [ファンドコード] = @ファンドコード)
      UNION
      SELECT N'版種', [版種] FROM t
        WHERE (@委託会社コード IS NULL OR [委託会社コード] = @委託会社コード)
          AND (@ファンドコード IS NULL OR [ファンドコード] = @ファンドコード)
          AND (@基準日 IS NULL OR [基準日] = @基準日)
    ) x
    ORDER BY [区分], [値];
    RETURN;
  END

  /* ---- 系列: 同一会社・同一版種のテンプレ(シリーズ判定の素) ------------- */
  IF @操作 = N'系列'
  BEGIN
    IF @委託会社コード IS NULL OR @版種 IS NULL
      THROW 50000, N'委託会社コードと版種が必要です', 1;
    SELECT [テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
           [ファイル名], [状態], [更新日時], [更新者]
      FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
      WHERE [論理削除] = 0
        AND [委託会社コード] = @委託会社コード
        AND [版種]           = @版種
      ORDER BY [ファンドコード], [基準日];
    RETURN;
  END

  /* ---- 生成登録: 生成直後の台帳行(draft)を冪等に作成 -------------------- */
  IF @操作 = N'生成登録'
  BEGIN
    IF @テンプレートID IS NULL OR @委託会社コード IS NULL OR @ファンドコード IS NULL
       OR @基準日 IS NULL OR @版種 IS NULL OR @ファイル名 IS NULL
      THROW 50000, N'生成登録には属性4とファイル名が必要です', 1;
    IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
                   WHERE [テンプレートID] = @テンプレートID)
      INSERT INTO [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
        ([テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
         [ファイル名], [状態])
      VALUES
        (@テンプレートID, @委託会社コード, @ファンドコード, @基準日, @版種,
         @ファイル名, N'draft');
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(テンプレート)', 1;
END
GO
