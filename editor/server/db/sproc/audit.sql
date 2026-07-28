/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_監査ログ
 *  @操作: 登録(best-effort, logger.audit から二重化)
 *  JSON はテキスト保管。参照は DB 直クエリで行う(検索用の @操作 は呼び出し元が無く廃止)。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_監査ログ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_監査ログ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_監査ログ]
  @操作        NVARCHAR(32),
  @イベント    NVARCHAR(64)  = NULL,
  @結果        NVARCHAR(8)   = NULL,
  @実行者      NVARCHAR(64)  = NULL,
  @IP          NVARCHAR(64)  = NULL,
  @リソースJSON NVARCHAR(MAX) = NULL,
  @詳細JSON     NVARCHAR(MAX) = NULL,
  @エラー       NVARCHAR(MAX) = NULL
AS
BEGIN
  SET NOCOUNT ON;

  IF @操作 = N'登録'
  BEGIN
    IF @イベント IS NULL OR @結果 IS NULL OR @実行者 IS NULL
      THROW 50000, N'イベント・結果・実行者 が必要です', 1;
    INSERT INTO [ug01].[Rep1_運報自動化_Editor_監査ログ]
      ([イベント], [結果], [実行者], [IP], [リソースJSON], [詳細JSON], [エラー])
    VALUES
      (@イベント, @結果, @実行者, @IP, @リソースJSON, @詳細JSON, @エラー);
    RETURN;
  END

  THROW 50000, N'未知の @操作 です(監査ログ)', 1;
END
GO
