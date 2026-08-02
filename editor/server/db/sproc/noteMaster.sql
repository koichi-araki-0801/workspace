/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_注記マスタ
 *  @操作: 取得(ファンド・版種の全行) / 反映(1 パーツの upsert)
 *  対象テーブルは仮組(01_テーブル.sql の 7 節)。実運用の既存注記テーブルへ差し替える際は
 *  この sproc の中身だけを実テーブル向けに書き換え、呼び出し側(noteMasterService.ts)の
 *  契約(@操作と結果列)は保つ。
 *  ※ パーツ単位の作業メモ(notes = dataRoot/notes/<templateId>.json)とは別物。こちらは注記文言の
 *    マスタで、承認確定パーツの書き戻しと次回テンプレ生成時の適用に使う。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_注記マスタ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_注記マスタ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_注記マスタ]
  @操作            NVARCHAR(32),
  @パーツID        NVARCHAR(64)  = NULL,
  @ファンドコード  NVARCHAR(32)  = NULL,
  @版種            NVARCHAR(16)  = NULL,
  @注記HTML        NVARCHAR(MAX) = NULL,
  @更新者          NVARCHAR(64)  = NULL
AS
BEGIN
  SET NOCOUNT ON;

  /* ---- 取得: ファンド・版種の注記行(テンプレ生成時の適用に使う) ---------- */
  IF @操作 = N'取得'
  BEGIN
    IF @ファンドコード IS NULL OR @版種 IS NULL
      THROW 50000, N'ファンドコードと版種が必要です', 1;
    SELECT [パーツID], [注記HTML]
      FROM [ug01].[Rep1_運報自動化_Editor_注記マスタ]
      WHERE [ファンドコード] = @ファンドコード
        AND [版種]           = @版種
      ORDER BY [注記内部ID];
    RETURN;
  END

  /* ---- 反映: 承認確定パーツの書き戻し(無ければ INSERT の upsert) ---------- */
  /* 対象宣言の正典はカタログの [次回反映既定] 列であり、マスタ行の事前 seed を要求しない
     ため UPDATE only でなく upsert。MERGE は使わない(2012 互換の範囲でも競合時の意図が
     読みにくく、呼び出しは承認フローで直列のため IF EXISTS で十分)。 */
  IF @操作 = N'反映'
  BEGIN
    IF @パーツID IS NULL OR @ファンドコード IS NULL OR @版種 IS NULL
      THROW 50000, N'パーツID・ファンドコード・版種が必要です', 1;
    IF EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_注記マスタ]
                WHERE [パーツID] = @パーツID
                  AND [ファンドコード] = @ファンドコード
                  AND [版種] = @版種)
      UPDATE [ug01].[Rep1_運報自動化_Editor_注記マスタ]
        SET [注記HTML] = @注記HTML,
            [更新日時] = SYSUTCDATETIME(),
            [更新者]   = @更新者
        WHERE [パーツID] = @パーツID
          AND [ファンドコード] = @ファンドコード
          AND [版種] = @版種;
    ELSE
      INSERT INTO [ug01].[Rep1_運報自動化_Editor_注記マスタ]
        ([パーツID], [ファンドコード], [版種], [注記HTML], [更新日時], [更新者])
        VALUES (@パーツID, @ファンドコード, @版種, @注記HTML, SYSUTCDATETIME(), @更新者);
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(注記マスタ)', 1;
END
GO
