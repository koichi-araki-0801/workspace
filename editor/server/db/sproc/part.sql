/* ============================================================================
 *  ゲートウェイ sproc: Rep1_運報自動化_Editor_usp_パーツ
 *  @操作: 分類候補(1 結果セット, 区分で判別, カスケード) / 一覧(分類で絞込)
 *  パーツ変更履歴はファイル監査ログ(logs/history/part.jsonl)側へ移行済み。
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

  /* 並びは五十音順でなく、parts.json 記載＝使用順(表紙から)に合わせる。seed は配列順に
     INSERT するので IDENTITY の [パーツ内部ID] が使用順を表す(別途の表示順カラムは不要)。 */
  IF @操作 = N'分類候補'
  BEGIN
    ;WITH p AS (
      SELECT [パーツ内部ID], [カテゴリ], [大分類], [中分類], [小分類]
        FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    )
    /* 各区分の値を初出の内部ID順で出す(GROUP BY で重複排除し MIN(内部ID)で使用順)。
       [区分順] は区分グループの並び(カテゴリ→大→中→小)を固定するための補助列。 */
    SELECT [区分], [値] FROM (
      SELECT N'カテゴリ' AS [区分], [カテゴリ] AS [値], 1 AS [区分順], MIN([パーツ内部ID]) AS [使用順]
        FROM p GROUP BY [カテゴリ]
      UNION ALL
      SELECT N'大分類', [大分類], 2, MIN([パーツ内部ID]) FROM p
        WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
        GROUP BY [大分類]
      UNION ALL
      SELECT N'中分類', [中分類], 3, MIN([パーツ内部ID]) FROM p
        WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
          AND (@大分類 IS NULL OR [大分類] = @大分類)
        GROUP BY [中分類]
      UNION ALL
      SELECT N'小分類', [小分類], 4, MIN([パーツ内部ID]) FROM p
        WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
          AND (@大分類 IS NULL OR [大分類] = @大分類)
          AND (@中分類 IS NULL OR [中分類] = @中分類)
        GROUP BY [小分類]
    ) x
    ORDER BY [区分順], [使用順];
    RETURN;
  END

  IF @操作 = N'一覧'
  BEGIN
    SELECT [パーツID], [カテゴリ], [大分類], [中分類], [小分類],
           [名称], [説明], [使用上の注意], [内容HTML], [更新日時], [更新者], [同期既定],
           [次回反映既定]
      FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
      WHERE (@カテゴリ IS NULL OR [カテゴリ] = @カテゴリ)
        AND (@大分類   IS NULL OR [大分類]   = @大分類)
        AND (@中分類   IS NULL OR [中分類]   = @中分類)
        AND (@小分類   IS NULL OR [小分類]   = @小分類)
      ORDER BY [パーツ内部ID];
    RETURN;
  END;

  THROW 50000, N'未知の @操作 です(パーツ)', 1;
END
GO
