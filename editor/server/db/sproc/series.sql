/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_シリーズ
 *  @操作 で分岐: 一覧
 *  作成タブの「シリーズから作成」で、同じシリーズのファンド(コピー元の候補)を求める素。
 *  Rep1 のファンド属性テーブルを 3 部名で読む。テーブル名・列名は仮で、返す列名
 *  [ファンドコード] [シリーズコード] は固定(違うときは AS で合わせる)。シリーズに
 *  属さないファンドは [シリーズコード] を NULL で返す。
 *  SQL Server 2012 互換: CREATE OR ALTER 不可 → DROP+CREATE。UTF-8 BOM。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_シリーズ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_シリーズ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_シリーズ]
  @操作              NVARCHAR(32),
  @委託会社コード    NVARCHAR(32)  = NULL
AS
BEGIN
  SET NOCOUNT ON;

  IF @操作 = N'一覧'
  BEGIN
    IF @委託会社コード IS NULL
      THROW 50000, N'委託会社コードが必要です', 1;
    SELECT RTRIM(CAST([ファンドコード] AS NVARCHAR(32))) AS [ファンドコード],
           NULLIF(RTRIM(CAST([シリーズコード] AS NVARCHAR(32))), N'') AS [シリーズコード]
      FROM [Rep1].[dbo].[Rep1_投信ファンド属性]
      WHERE [委託会社コード] = @委託会社コード
      ORDER BY [ファンドコード];
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(シリーズ)', 1;
END
GO
