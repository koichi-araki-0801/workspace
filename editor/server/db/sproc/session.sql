/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_セッション
 *  @操作: 作成 / 取得 / 失効 / 全失効 / 掃除  (cookie editor.sid。DB 保持で再起動耐性)
 *  取得は有効(失効=0 かつ 有効期限>now)なら最終アクセスを更新しユーザーを返す。
 *  全失効はサーバ起動時に呼び、再起動をまたいだ旧セッションを一括で無効化する
 *  (再起動後は全員に再ログインを強制する。Node 側 invalidateAllSessions が起動フックで実行)。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_セッション]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_セッション];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_セッション]
  @操作        NVARCHAR(32),
  @セッションID NVARCHAR(64)  = NULL,
  @ログインID   NVARCHAR(64)  = NULL,
  @有効期限     DATETIME2(3)  = NULL,
  @保持日数     INT           = NULL
AS
BEGIN
  SET NOCOUNT ON;

  IF @操作 = N'作成'
  BEGIN
    IF @セッションID IS NULL OR @ログインID IS NULL OR @有効期限 IS NULL
      THROW 50000, N'セッションID・ログインID・有効期限 が必要です', 1;
    INSERT INTO [ug01].[Rep1_運報自動化_Editor_セッション]
      ([セッションID], [ログインID], [有効期限])
    VALUES (@セッションID, @ログインID, @有効期限);
    RETURN;
  END

  IF @操作 = N'取得'
  BEGIN
    IF @セッションID IS NULL THROW 50000, N'セッションID が必要です', 1;
    UPDATE [ug01].[Rep1_運報自動化_Editor_セッション]
      SET [最終アクセス] = SYSUTCDATETIME()
      WHERE [セッションID] = @セッションID
        AND [失効] = 0
        AND [有効期限] > SYSUTCDATETIME();
    /* 有効なら紐づくユーザーを返す(無効ユーザー判定は Node 側) */
    SELECT u.[公開ID], u.[ログインID], u.[表示名], u.[ロール],
           u.[無効], u.[要パスワード変更]
      FROM [ug01].[Rep1_運報自動化_Editor_セッション] s
      JOIN [ug01].[Rep1_運報自動化_Editor_ユーザー] u
        ON u.[ログインID] = s.[ログインID]
      WHERE s.[セッションID] = @セッションID
        AND s.[失効] = 0
        AND s.[有効期限] > SYSUTCDATETIME();
    RETURN;
  END

  IF @操作 = N'失効'
  BEGIN
    IF @セッションID IS NULL THROW 50000, N'セッションID が必要です', 1;
    UPDATE [ug01].[Rep1_運報自動化_Editor_セッション]
      SET [失効] = 1
      WHERE [セッションID] = @セッションID;
    RETURN;
  END

  /* 全失効: 生存中の全セッションを論理失効。引数なし。サーバ起動時に一括実行する。 */
  IF @操作 = N'全失効'
  BEGIN
    UPDATE [ug01].[Rep1_運報自動化_Editor_セッション]
      SET [失効] = 1
      WHERE [失効] = 0;
    RETURN;
  END

  /* 掃除: 失効済み/期限切れの行を物理削除する。失効(全失効を含む)は論理フラグを立てる
     だけなので、行はログインのたびに単調増加する。監査の観点で即時削除はせず、
     「有効期限が @保持日数 ぶん過去」を境界にする。**この境界を SYSUTCDATETIME() 単体へ
     縮めてはならない** — 期限内の行まで消し、全員が突然ログアウトする。 */
  IF @操作 = N'掃除'
  BEGIN
    IF @保持日数 IS NULL THROW 50000, N'保持日数 が必要です', 1;
    DELETE FROM [ug01].[Rep1_運報自動化_Editor_セッション]
      WHERE [有効期限] < DATEADD(day, -@保持日数, SYSUTCDATETIME());
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(セッション)', 1;
END
GO
