/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_サンプルデータ
 *  @操作: 取得 / 登録(upsert, seed)   JSON はテキスト保管(2012: OPENJSON 不可)。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_サンプルデータ]
  @操作          NVARCHAR(32),
  @ファンドコード NVARCHAR(32)  = NULL,
  @データJSON     NVARCHAR(MAX) = NULL
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

  IF @操作 = N'登録'
  BEGIN
    IF @ファンドコード IS NULL OR @データJSON IS NULL
      THROW 50000, N'ファンドコード・データJSON が必要です', 1;
    IF EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_サンプルデータ]
               WHERE [ファンドコード] = @ファンドコード)
      UPDATE [ug01].[Rep1_運報自動化_Editor_サンプルデータ]
        SET [データJSON] = @データJSON, [更新日時] = SYSUTCDATETIME()
        WHERE [ファンドコード] = @ファンドコード;
    ELSE
      INSERT INTO [ug01].[Rep1_運報自動化_Editor_サンプルデータ]
        ([ファンドコード], [データJSON], [更新日時])
      VALUES (@ファンドコード, @データJSON, SYSUTCDATETIME());
    RETURN;
  END

  THROW 50000, N'未知の @操作 です(サンプルデータ)', 1;
END
GO
