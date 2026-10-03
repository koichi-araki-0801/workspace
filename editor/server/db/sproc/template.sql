/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_テンプレート
 *  @操作 で分岐: 委託会社一覧 / ファンド一覧
 *  作成タブの会社・ファンドの候補を Rep1(同じサーバ)から 3 部名で読む。返す委託会社略称が
 *  ファイル名の会社コード。テンプレの一覧/取得・確定保存・下書きはファイル + git 側(本 sproc 対象外)。
 *  SQL Server 2012 互換: CREATE OR ALTER 不可 → DROP+CREATE。UTF-8 BOM。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_テンプレート]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_テンプレート];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_テンプレート]
  @操作              NVARCHAR(32),
  @委託会社コード    NVARCHAR(32)  = NULL
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
  END;

  THROW 50000, N'未知の @操作 です(テンプレート)', 1;
END
GO
