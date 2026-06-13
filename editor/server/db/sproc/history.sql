/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_履歴
 *  @操作: 一覧(+@種別) / 登録(+@種別=pdf|create|part) / バージョン一覧 /
 *         スナップ取得 / パーツ履歴
 *  履歴は 4 種統合。edit 行はスナップショット列も保持。user は表示名(join)。
 *  確定保存(edit)は usp_テンプレート 側で INSERT する(本 sproc は pdf/create/part)。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_履歴]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_履歴];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_履歴]
  @操作              NVARCHAR(32),
  @種別              NVARCHAR(16)  = NULL,
  @公開ID            NVARCHAR(64)  = NULL,
  @テンプレートID    NVARCHAR(128) = NULL,
  @ログインID        NVARCHAR(64)  = NULL,
  @パーツID          NVARCHAR(64)  = NULL,
  @変更内容          NVARCHAR(512) = NULL,
  @委託会社コード    NVARCHAR(32)  = NULL,
  @作成ファンドコード NVARCHAR(32) = NULL,
  @基準日            NVARCHAR(8)   = NULL,
  @版種              NVARCHAR(16)  = NULL,
  @元テンプレートID  NVARCHAR(128) = NULL
AS
BEGIN
  SET NOCOUNT ON;

  /* ---- 一覧: 種別ごとのフィード(列は superset、server が種別で整形) ----- */
  IF @操作 = N'一覧'
  BEGIN
    IF @種別 IS NULL THROW 50000, N'種別 が必要です', 1;
    SELECT h.[公開ID], h.[種別], h.[テンプレートID], h.[発生日時],
           h.[概要], h.[パーツID], h.[変更内容],
           h.[委託会社コード], h.[作成ファンドコード], h.[基準日], h.[版種],
           h.[元テンプレートID],
           ISNULL(u.[表示名], h.[ログインID]) AS [表示名]
      FROM [ug01].[Rep1_運報自動化_Editor_履歴] h
      LEFT JOIN [ug01].[Rep1_運報自動化_Editor_ユーザー] u
        ON u.[ログインID] = h.[ログインID]
      WHERE h.[種別] = @種別
      ORDER BY h.[発生日時] DESC;
    RETURN;
  END

  /* ---- 登録: pdf / create / part(edit は確定保存側) ---------------------- */
  IF @操作 = N'登録'
  BEGIN
    IF @種別 IS NULL OR @公開ID IS NULL OR @ログインID IS NULL
      THROW 50000, N'種別・公開ID・ログインID が必要です', 1;
    IF @種別 = N'edit'
      THROW 50000, N'edit は確定保存(usp_テンプレート)で登録します', 1;
    INSERT INTO [ug01].[Rep1_運報自動化_Editor_履歴]
      ([公開ID], [種別], [テンプレートID], [ログインID], [発生日時],
       [パーツID], [変更内容],
       [委託会社コード], [作成ファンドコード], [基準日], [版種], [元テンプレートID])
    VALUES
      (@公開ID, @種別, @テンプレートID, @ログインID, SYSUTCDATETIME(),
       @パーツID, @変更内容,
       @委託会社コード, @作成ファンドコード, @基準日, @版種, @元テンプレートID);
    RETURN;
  END

  /* ---- バージョン一覧: スナップショット有りの確定版(新しい順) ----------- */
  IF @操作 = N'バージョン一覧'
  BEGIN
    IF @テンプレートID IS NULL THROW 50000, N'テンプレートID が必要です', 1;
    SELECT h.[公開ID], h.[テンプレートID], h.[発生日時], h.[概要],
           ISNULL(u.[表示名], h.[ログインID]) AS [表示名]
      FROM [ug01].[Rep1_運報自動化_Editor_履歴] h
      LEFT JOIN [ug01].[Rep1_運報自動化_Editor_ユーザー] u
        ON u.[ログインID] = h.[ログインID]
      WHERE h.[種別] = N'edit'
        AND h.[テンプレートID] = @テンプレートID
        AND h.[スナップHTMLファイル] IS NOT NULL
      ORDER BY h.[発生日時] DESC;
    RETURN;
  END

  /* ---- スナップ取得: meta(本文はサーバがファイル読込) -------------------- */
  IF @操作 = N'スナップ取得'
  BEGIN
    IF @公開ID IS NULL THROW 50000, N'公開ID が必要です', 1;
    SELECT [公開ID], [テンプレートID], [ファンドコード],
           [スナップHTMLファイル], [スナップCSSファイル], [発生日時]
      FROM [ug01].[Rep1_運報自動化_Editor_履歴]
      WHERE [種別] = N'edit' AND [公開ID] = @公開ID;
    RETURN;
  END

  /* ---- パーツ履歴: テンプレート×パーツ単位 ------------------------------ */
  IF @操作 = N'パーツ履歴'
  BEGIN
    IF @テンプレートID IS NULL OR @パーツID IS NULL
      THROW 50000, N'テンプレートID・パーツID が必要です', 1;
    SELECT h.[公開ID], h.[テンプレートID], h.[パーツID], h.[発生日時], h.[変更内容],
           ISNULL(u.[表示名], h.[ログインID]) AS [表示名]
      FROM [ug01].[Rep1_運報自動化_Editor_履歴] h
      LEFT JOIN [ug01].[Rep1_運報自動化_Editor_ユーザー] u
        ON u.[ログインID] = h.[ログインID]
      WHERE h.[種別] = N'part'
        AND h.[テンプレートID] = @テンプレートID
        AND h.[パーツID] = @パーツID
      ORDER BY h.[発生日時] DESC;
    RETURN;
  END

  THROW 50000, N'未知の @操作 です(履歴)', 1;
END
GO
