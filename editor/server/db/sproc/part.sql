/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_パーツ
 *  @操作: 分類候補(1 結果セット, 区分で判別, カスケード) / 一覧(分類で絞込)
 *  パーツ履歴は usp_履歴(@操作='パーツ履歴') 側。
 * ==========================================================================*/

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_usp_パーツ]', N'P') IS NOT NULL
  DROP PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_パーツ];
GO

CREATE PROCEDURE [ug01].[Rep1_運報自動化_Editor_usp_パーツ]
  @操作      NVARCHAR(32),
  @カテゴリ  NVARCHAR(64) = NULL,
  @大分類    NVARCHAR(64) = NULL,
  @中分類    NVARCHAR(64) = NULL,
  @小分類    NVARCHAR(64) = NULL
AS
BEGIN
  SET NOCOUNT ON;

  IF @操作 = N'分類候補'
  BEGIN
    ;WITH p AS (
      SELECT [カテゴリ], [大分類], [中分類], [小分類]
        FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    )
    SELECT [区分], [値] FROM (
      SELECT N'カテゴリ' AS [区分], [カテゴリ] AS [値] FROM p
      UNION
      SELECT N'大分類', [大分類] FROM p
        WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
      UNION
      SELECT N'中分類', [中分類] FROM p
        WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
          AND (@大分類 IS NULL OR [大分類] = @大分類)
      UNION
      SELECT N'小分類', [小分類] FROM p
        WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
          AND (@大分類 IS NULL OR [大分類] = @大分類)
          AND (@中分類 IS NULL OR [中分類] = @中分類)
    ) x
    ORDER BY [区分], [値];
    RETURN;
  END

  IF @操作 = N'一覧'
  BEGIN
    SELECT [パーツID], [カテゴリ], [大分類], [中分類], [小分類],
           [名称], [説明], [使用上の注意], [内容HTML], [更新日時], [更新者]
      FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
      WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
        AND (@大分類   IS NULL OR [大分類]   = @大分類)
        AND (@中分類   IS NULL OR [中分類]   = @中分類)
        AND (@小分類   IS NULL OR [小分類]   = @小分類)
      ORDER BY [カテゴリ], [大分類], [中分類], [小分類], [名称];
    RETURN;
  END

  THROW 50000, N'未知の @操作 です(パーツ)', 1;
END
GO
