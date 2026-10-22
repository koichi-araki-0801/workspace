/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_サンプルデータ
 *  @操作: 共通一覧   引数なし。共通サンプルの全行を ID 昇順で返す。
 *  JSON はテキスト保管(2012: OPENJSON 不可)で、行の合成は server が行う。
 *  seed は `db/seed/共通サンプル.sql` がテーブルへ直接 INSERT する。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ]
  @操作 NVARCHAR(32)
AS
BEGIN
  SET NOCOUNT ON;

  IF @操作 = N'共通一覧'
  BEGIN
    SELECT [共通サンプルID], [カテゴリ], [大分類], [中分類], [小分類], [データJSON]
      FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル]
      ORDER BY [共通サンプルID];
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(サンプルデータ)', 1;
END
GO
