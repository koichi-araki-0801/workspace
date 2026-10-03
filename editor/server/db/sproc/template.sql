/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_テンプレート
 *  @操作 で分岐: 委託会社一覧 / ファンド一覧 / 候補 / 生成登録
 *  委託会社一覧・ファンド一覧は Rep1(同じサーバ)を 3 部名で読む。返す委託会社略称がファイル名の会社コード。
 *  台帳は「作成可能カタログ」(作成タブの候補の源)と生成登録のみを担う。既存テンプレの
 *  一覧/取得・系列・確定保存・下書き・版/スナップはファイル + git 側(本 sproc 対象外)。
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

  /* ---- 委託会社一覧: 作成タブの会社プルダウン(Rep1 のファンド属性系テーブル) ------- */
  /* テーブル名・列名は仮。返す列名は固定で、実際の名前が違うときは FROM と AS を直す。  */
  /* CHAR 型でも末尾空白で照合がずれないよう、文字列化して右の空白を落として返す。       */
  IF @操作 = N'委託会社一覧'
  BEGIN
    SELECT RTRIM(CAST([委託会社コード] AS NVARCHAR(32)))  AS [委託会社コード],
           RTRIM(CAST([委託会社名]     AS NVARCHAR(256))) AS [委託会社名],
           RTRIM(CAST([委託会社略称]   AS NVARCHAR(32)))  AS [委託会社略称]
      FROM [Rep1].[dbo].[Rep1_投委託会社]
      ORDER BY [委託会社コード];
    RETURN;
  END

  /* ---- ファンド一覧: 会社を選んだときに 1 回で引く -------------------------------- */
  IF @操作 = N'ファンド一覧'
  BEGIN
    IF @委託会社コード IS NULL
      THROW 50000, N'委託会社コードが必要です', 1;
    SELECT RTRIM(CAST([ファンドコード] AS NVARCHAR(32)))  AS [ファンドコード],
           RTRIM(CAST([ファンド名]     AS NVARCHAR(256))) AS [ファンド名]
      FROM [Rep1].[dbo].[Rep1_投信ファンド属性]
      WHERE [委託会社コード] = @委託会社コード
      ORDER BY [ファンドコード];
    RETURN;
  END

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
