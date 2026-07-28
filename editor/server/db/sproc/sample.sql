/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_サンプルデータ
 *  @操作: 取得   JSON はテキスト保管(2012: OPENJSON 不可)。
 *  seed は `db/seed/サンプルデータ.sql` がテーブルへ直接 INSERT する(登録用の @操作 は
 *  呼び出し元が無く廃止)。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ]
  @操作          NVARCHAR(32),
  @ファンドコード NVARCHAR(32)  = NULL
AS
BEGIN
  SET NOCOUNT ON;

  IF @操作 = N'取得'
  BEGIN
    IF @ファンドコード IS NULL THROW 50000, N'ファンドコード が必要です', 1;
    SELECT [データJSON]
      FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ]
      WHERE [ファンドコード] = @ファンドコード;
    RETURN;
  END

  THROW 50000, N'未知の @操作 です(サンプルデータ)', 1;
END
GO
