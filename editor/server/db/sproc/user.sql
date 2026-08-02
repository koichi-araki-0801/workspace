/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_ユーザー
 *  @操作: 一覧 / 作成 / 更新 / PWリセット / 認証情報取得 / PW初期化
 *  PW は PBKDF2 派生鍵+ソルト。照合は Node 側(timingSafeEqual)。
 *  THROW 番号 → kind: 50404=not_found / 50409=conflict / 50000=validation。
 *  一覧/作成/更新はハッシュ列を返さない。認証情報取得のみハッシュを返す。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_ユーザー]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_ユーザー];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_ユーザー]
  @操作              NVARCHAR(32),
  @公開ID            NVARCHAR(64)  = NULL,
  @ログインID        NVARCHAR(64)  = NULL,
  @表示名            NVARCHAR(128) = NULL,
  @ロール            NVARCHAR(16)  = NULL,
  @無効              BIT           = NULL,
  @要パスワード変更  BIT           = NULL,
  @PWハッシュ        VARBINARY(64) = NULL,
  @PWソルト          VARBINARY(32) = NULL,
  @PW反復回数        INT           = NULL
AS
BEGIN
  SET NOCOUNT ON;

  /* ---- 一覧(ハッシュ列は出さない) -------------------------------------- */
  IF @操作 = N'一覧'
  BEGIN
    SELECT [公開ID], [ログインID], [表示名], [ロール], [無効], [要パスワード変更]
      FROM [ug01].[Rep1_運報自動化_Editor_ユーザー]
      ORDER BY [作成日時];
    RETURN;
  END

  /* ---- 作成 ------------------------------------------------------------- */
  IF @操作 = N'作成'
  BEGIN
    IF @公開ID IS NULL OR @ログインID IS NULL OR @表示名 IS NULL OR @ロール IS NULL
      THROW 50000, N'公開ID・ログインID・表示名・ロール が必要です', 1;
    IF EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_ユーザー]
               WHERE [ログインID] = @ログインID)
      THROW 50409, N'このログインIDは既に使われています', 1;
    INSERT INTO [ug01].[Rep1_運報自動化_Editor_ユーザー]
      ([公開ID], [ログインID], [表示名], [ロール], [無効], [要パスワード変更],
       [PWハッシュ], [PWソルト], [PW反復回数])
    VALUES
      (@公開ID, @ログインID, @表示名, @ロール,
       ISNULL(@無効, 0), ISNULL(@要パスワード変更, 1),
       @PWハッシュ, @PWソルト, @PW反復回数);
    SELECT [公開ID], [ログインID], [表示名], [ロール], [無効], [要パスワード変更]
      FROM [ug01].[Rep1_運報自動化_Editor_ユーザー]
      WHERE [公開ID] = @公開ID;
    RETURN;
  END

  /* ---- 更新(部分更新: 渡された列のみ) ---------------------------------- */
  IF @操作 = N'更新'
  BEGIN
    IF @公開ID IS NULL THROW 50000, N'公開ID が必要です', 1;
    UPDATE [ug01].[Rep1_運報自動化_Editor_ユーザー]
      SET [表示名]           = COALESCE(@表示名, [表示名]),
          [ロール]           = COALESCE(@ロール, [ロール]),
          [無効]             = COALESCE(@無効, [無効]),
          [要パスワード変更] = COALESCE(@要パスワード変更, [要パスワード変更]),
          [更新日時]         = SYSUTCDATETIME()
      WHERE [公開ID] = @公開ID;
    IF @@ROWCOUNT = 0 THROW 50404, N'ユーザーが見つかりません', 1;
    SELECT [公開ID], [ログインID], [表示名], [ロール], [無効], [要パスワード変更]
      FROM [ug01].[Rep1_運報自動化_Editor_ユーザー]
      WHERE [公開ID] = @公開ID;
    RETURN;
  END

  /* ---- PWリセット(仮ハッシュへ + 要変更フラグ) ------------------------- */
  IF @操作 = N'PWリセット'
  BEGIN
    IF @公開ID IS NULL OR @PWハッシュ IS NULL OR @PWソルト IS NULL
      THROW 50000, N'公開ID・仮ハッシュ が必要です', 1;
    UPDATE [ug01].[Rep1_運報自動化_Editor_ユーザー]
      SET [PWハッシュ] = @PWハッシュ, [PWソルト] = @PWソルト,
          [PW反復回数] = @PW反復回数, [要パスワード変更] = 1,
          [更新日時] = SYSUTCDATETIME()
      WHERE [公開ID] = @公開ID;
    IF @@ROWCOUNT = 0 THROW 50404, N'ユーザーが見つかりません', 1;
    RETURN;
  END

  /* ---- 認証情報取得(login 用、ハッシュを返す。0 行=不在) --------------- */
  IF @操作 = N'認証情報取得'
  BEGIN
    IF @ログインID IS NULL THROW 50000, N'ログインID が必要です', 1;
    SELECT [公開ID], [ログインID], [表示名], [ロール], [無効], [要パスワード変更],
           [PWハッシュ], [PWソルト], [PW反復回数]
      FROM [ug01].[Rep1_運報自動化_Editor_ユーザー]
      WHERE [ログインID] = @ログインID;
    RETURN;
  END

  /* ---- PW初期化(初回ログイン時、要変更フラグ解除) ---------------------- */
  IF @操作 = N'PW初期化'
  BEGIN
    IF @ログインID IS NULL OR @PWハッシュ IS NULL OR @PWソルト IS NULL
      THROW 50000, N'ログインID・新ハッシュ が必要です', 1;
    UPDATE [ug01].[Rep1_運報自動化_Editor_ユーザー]
      SET [PWハッシュ] = @PWハッシュ, [PWソルト] = @PWソルト,
          [PW反復回数] = @PW反復回数, [要パスワード変更] = 0,
          [更新日時] = SYSUTCDATETIME()
      WHERE [ログインID] = @ログインID;
    IF @@ROWCOUNT = 0 THROW 50404, N'ユーザーが見つかりません', 1;
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(ユーザー)', 1;
END
GO
