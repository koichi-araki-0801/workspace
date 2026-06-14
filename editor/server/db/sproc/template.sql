/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_テンプレート
 *  @操作 で分岐: 候補 / 一覧 / 取得 / 系列 / 下書き保存 / 下書き取得 / 確定保存
 *  本文(html/css)はファイル。台帳はメタ+下書き/版の索引のみ。
 *  SQL Server 2012 互換: CREATE OR ALTER 不可 → DROP+CREATE。UTF-8 BOM。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_テンプレート]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_テンプレート];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_テンプレート]
  @操作              NVARCHAR(32),
  @テンプレートID    NVARCHAR(128) = NULL,
  @委託会社コード    NVARCHAR(32)  = NULL,
  @ファンドコード    NVARCHAR(32)  = NULL,
  @基準日            NVARCHAR(8)   = NULL,
  @版種              NVARCHAR(16)  = NULL,
  @ファイル名        NVARCHAR(160) = NULL,
  @ログインID        NVARCHAR(64)  = NULL,
  @概要              NVARCHAR(400) = NULL,
  @公開ID            NVARCHAR(64)  = NULL,
  @下書きHTMLファイル   NVARCHAR(260) = NULL,
  @下書きCSSファイル    NVARCHAR(260) = NULL,
  @スナップHTMLファイル NVARCHAR(260) = NULL,
  @スナップCSSファイル  NVARCHAR(260) = NULL
AS
BEGIN
  SET NOCOUNT ON;

  /* ---- 候補: カスケードドロップダウン(1 結果セット, 区分で判別) ---------- */
  IF @操作 = N'候補'
  BEGIN
    ;WITH t AS (
      SELECT [委託会社コード], [ファンドコード], [基準日], [版種]
        FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
        WHERE [論理削除] = 0
    )
    SELECT [区分], [値] FROM (
      SELECT N'会社' AS [区分], [委託会社コード] AS [値] FROM t
      UNION
      SELECT N'ファンド', [ファンドコード] FROM t
        WHERE (@委託会社コード IS NULL OR [委託会社コード] = @委託会社コード)
      UNION
      SELECT N'基準日', [基準日] FROM t
        WHERE (@委託会社コード IS NULL OR [委託会社コード] = @委託会社コード)
          AND (@ファンドコード IS NULL OR [ファンドコード] = @ファンドコード)
          AND (@基準日 IS NULL OR [基準日] = @基準日)
          AND (@版種   IS NULL OR [版種]   = @版種)
      UNION
      SELECT N'版種', [版種] FROM t
        WHERE (@委託会社コード IS NULL OR [委託会社コード] = @委託会社コード)
          AND (@ファンドコード IS NULL OR [ファンドコード] = @ファンドコード)
          AND (@基準日 IS NULL OR [基準日] = @基準日)
          AND (@版種   IS NULL OR [版種]   = @版種)
    ) x
    ORDER BY [区分], [値];
    RETURN;
  END

  /* ---- 一覧: 属性で絞り込んだ TemplateMeta -------------------------------- */
  IF @操作 = N'一覧'
  BEGIN
    SELECT [テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
           [ファイル名], [状態], [更新日時], [更新者]
      FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
      WHERE [論理削除] = 0
        AND (@委託会社コード IS NULL OR [委託会社コード] = @委託会社コード)
        AND (@ファンドコード IS NULL OR [ファンドコード] = @ファンドコード)
        AND (@基準日         IS NULL OR [基準日]       = @基準日)
        AND (@版種           IS NULL OR [版種]         = @版種)
      ORDER BY [委託会社コード], [ファンドコード], [基準日], [版種];
    RETURN;
  END

  /* ---- 取得: 1 件の meta (本文はサーバがファイル読込) --------------------- */
  IF @操作 = N'取得'
  BEGIN
    IF @テンプレートID IS NULL THROW 50000, N'テンプレートID が必要です', 1;
    SELECT [テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
           [ファイル名], [状態], [更新日時], [更新者]
      FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
      WHERE [論理削除] = 0 AND [テンプレートID] = @テンプレートID;
    RETURN;
  END

  /* ---- 系列: 同一会社・同一版種のテンプレ ------------------------------- */
  IF @操作 = N'系列'
  BEGIN
    IF @委託会社コード IS NULL OR @版種 IS NULL
      THROW 50000, N'委託会社コードと版種が必要です', 1;
    SELECT [テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
           [ファイル名], [状態], [更新日時], [更新者]
      FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
      WHERE [論理削除] = 0
        AND [委託会社コード] = @委託会社コード
        AND [版種]           = @版種
      ORDER BY [ファンドコード], [基準日];
    RETURN;
  END

  /* ---- 生成登録: 生成直後の台帳行(draft)を冪等に作成 -------------------- */
  IF @操作 = N'生成登録'
  BEGIN
    IF @テンプレートID IS NULL OR @委託会社コード IS NULL OR @ファンドコード IS NULL
       OR @基準日 IS NULL OR @版種 IS NULL OR @ファイル名 IS NULL
      THROW 50000, N'生成登録には属性4とファイル名が必要です', 1;
    IF NOT EXISTS (SELECT 1 FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
                   WHERE [テンプレートID] = @テンプレートID)
      INSERT INTO [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
        ([テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
         [ファイル名], [状態])
      VALUES
        (@テンプレートID, @委託会社コード, @ファンドコード, @基準日, @版種,
         @ファイル名, N'draft');
    RETURN;
  END

  /* ---- 下書き保存: 台帳の下書き列を upsert ------------------------------- */
  IF @操作 = N'下書き保存'
  BEGIN
    IF @テンプレートID IS NULL THROW 50000, N'テンプレートID が必要です', 1;
    UPDATE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
      SET [下書きHTMLファイル] = @下書きHTMLファイル,
          [下書きCSSファイル]  = @下書きCSSファイル,
          [下書き保存者]       = @ログインID,
          [下書き保存日時]     = SYSUTCDATETIME()
      WHERE [テンプレートID] = @テンプレートID;
    IF @@ROWCOUNT = 0
    BEGIN
      /* 台帳未登録なら属性付きで挿入(下書きのみの新規テンプレ) */
      IF @委託会社コード IS NULL OR @ファンドコード IS NULL
         OR @基準日 IS NULL OR @版種 IS NULL OR @ファイル名 IS NULL
        THROW 50000, N'新規下書きには属性4とファイル名が必要です', 1;
      INSERT INTO [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
        ([テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
         [ファイル名], [状態], [下書きHTMLファイル], [下書きCSSファイル],
         [下書き保存者], [下書き保存日時])
      VALUES
        (@テンプレートID, @委託会社コード, @ファンドコード, @基準日, @版種,
         @ファイル名, N'draft', @下書きHTMLファイル, @下書きCSSファイル,
         @ログインID, SYSUTCDATETIME());
    END
    RETURN;
  END

  /* ---- 下書き取得: 下書き列(無ければ 0 行) ------------------------------ */
  IF @操作 = N'下書き取得'
  BEGIN
    IF @テンプレートID IS NULL THROW 50000, N'テンプレートID が必要です', 1;
    SELECT [テンプレートID], [下書きHTMLファイル], [下書きCSSファイル],
           [下書き保存者], [下書き保存日時]
      FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
      WHERE [テンプレートID] = @テンプレートID
        AND [下書き保存日時] IS NOT NULL;
    RETURN;
  END

  /* ---- 確定保存: TX(台帳 published + 下書きクリア + 履歴 edit 行) -------- */
  IF @操作 = N'確定保存'
  BEGIN
    IF @テンプレートID IS NULL OR @ログインID IS NULL OR @公開ID IS NULL
      THROW 50000, N'テンプレートID・ログインID・公開ID が必要です', 1;
    SET XACT_ABORT ON;
    BEGIN TRAN;

      UPDATE [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
        SET [状態] = N'published',
            [更新日時] = SYSUTCDATETIME(),
            [更新者]   = @ログインID,
            [下書きHTMLファイル] = NULL,
            [下書きCSSファイル]  = NULL,
            [下書き保存者]       = NULL,
            [下書き保存日時]     = NULL
        WHERE [テンプレートID] = @テンプレートID;

      IF @@ROWCOUNT = 0
      BEGIN
        IF @委託会社コード IS NULL OR @ファンドコード IS NULL
           OR @基準日 IS NULL OR @版種 IS NULL OR @ファイル名 IS NULL
          THROW 50000, N'未登録テンプレートの確定には属性4とファイル名が必要です', 1;
        INSERT INTO [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
          ([テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
           [ファイル名], [状態], [更新日時], [更新者])
        VALUES
          (@テンプレートID, @委託会社コード, @ファンドコード, @基準日, @版種,
           @ファイル名, N'published', SYSUTCDATETIME(), @ログインID);
      END

      INSERT INTO [ug01].[Rep1_運報自動化_Editor_履歴]
        ([公開ID], [種別], [テンプレートID], [ログインID], [発生日時],
         [概要], [ファンドコード], [スナップHTMLファイル], [スナップCSSファイル])
      VALUES
        (@公開ID, N'edit', @テンプレートID, @ログインID, SYSUTCDATETIME(),
         ISNULL(@概要, N'確定保存'), @ファンドコード,
         @スナップHTMLファイル, @スナップCSSファイル);

    COMMIT TRAN;

    /* 更新後 meta を返す */
    SELECT [テンプレートID], [委託会社コード], [ファンドコード], [基準日], [版種],
           [ファイル名], [状態], [更新日時], [更新者]
      FROM [ug01].[Rep1_運報自動化_Editor_テンプレート台帳]
      WHERE [テンプレートID] = @テンプレートID;
    RETURN;
  END

  THROW 50000, N'未知の @操作 です(テンプレート)', 1;
END
GO
