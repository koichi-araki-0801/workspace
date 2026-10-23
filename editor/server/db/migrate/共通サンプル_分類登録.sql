/* ============================================================================
 *  移行: パーツカタログの分類から共通サンプルの行を作る(値は空)
 *  共通サンプルは分類(カテゴリ・大分類・中分類・小分類)ごとに値の JSON 断片を持つ。運用側が
 *  値を書き込む前に、カタログにある分類の組の行と、分類が全部空の「全体共通」の行を用意する。
 *  値(データJSON)は空の object `{}` で入れる。値の登録は運用側が本番の変数名で行う。
 *
 *  SSMS で開き、データベースに usrap を選んで実行する(sqlcmd 専用の命令は使っていない)。
 *  既定はプレビュー(登録しない)。結果タブに登録される行が出るので、確かめてから下の `@実行` を 1 に
 *  書き換えて実行し直す。登録した件数はメッセージタブに出る。
 *  sqlcmd でも流せる: sqlcmd -S <host\instance> -d usrap -E -b -f 65001 -i <このファイル>
 *  冪等。既にある分類の組(空は空文字列に寄せて比べる)は登録しないので、何度流してもよい。
 *  apply.ps1 の対象外。共通サンプルのテーブルを ddl で作った後に、手で 1 回流す。
 *  UTF-8 BOM。SQL Server 2012 互換。
 * ==========================================================================*/

SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;  -- 共通サンプルは計算列に索引があり、書き込みに必要(sqlcmd の既定は OFF)

DECLARE @実行 BIT = 0;  -- 0 = プレビュー / 1 = 登録

IF OBJECT_ID(N'[ug01].[Rep1_運報自動化_Editor_共通サンプル]', N'U') IS NULL
  THROW 50000, N'共通サンプルのテーブルがありません。データベースが usrap か、ddl を適用済みかを確かめてください', 1;

/* 登録候補。合成の順序は行の ID 昇順なので、全体共通の行を先頭にし、続けてカタログに
 * 最初に現れた順(パーツ内部ID の最小値)で並べる。カタログの分類が 4 段とも空の組は
 * 全体共通の行と同じ組になり、一意索引の違反で全体が戻るので、カタログ由来の候補から除く。
 * 照合順序はテーブル変数が DB の既定を取るので、カタログ・共通サンプルの列と同じものを
 * 明示する(違うと比較で照合の競合になる)。 */
DECLARE @候補 TABLE (
  [順]       INT          NOT NULL,
  [カテゴリ] NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL,
  [大分類]   NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL,
  [中分類]   NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL,
  [小分類]   NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL
);

INSERT INTO @候補 ([順], [カテゴリ], [大分類], [中分類], [小分類])
  VALUES (0, N'', N'', N'', N'');

INSERT INTO @候補 ([順], [カテゴリ], [大分類], [中分類], [小分類])
  SELECT ROW_NUMBER() OVER (ORDER BY MIN(p.[パーツ内部ID])),
         p.[カテゴリ], p.[大分類], p.[中分類], p.[小分類]
    FROM (
      SELECT [パーツ内部ID],
             ISNULL([カテゴリ], N'') AS [カテゴリ], ISNULL([大分類], N'') AS [大分類],
             ISNULL([中分類],   N'') AS [中分類],   ISNULL([小分類], N'') AS [小分類]
        FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
    ) AS p
    WHERE p.[カテゴリ] <> N'' OR p.[大分類] <> N'' OR p.[中分類] <> N'' OR p.[小分類] <> N''
    GROUP BY p.[カテゴリ], p.[大分類], p.[中分類], p.[小分類];

/* 既に登録済みの組を候補から外す。 */
DELETE c
  FROM @候補 AS c
  WHERE EXISTS (
    SELECT 1
      FROM [ug01].[Rep1_運報自動化_Editor_共通サンプル] AS s
      WHERE ISNULL(s.[カテゴリ], N'') = c.[カテゴリ]
        AND ISNULL(s.[大分類],   N'') = c.[大分類]
        AND ISNULL(s.[中分類],   N'') = c.[中分類]
        AND ISNULL(s.[小分類],   N'') = c.[小分類]);

SELECT [順], [カテゴリ], [大分類], [中分類], [小分類]
  FROM @候補
  ORDER BY [順];

IF @実行 = 0
BEGIN
  PRINT N'プレビューのみ(登録していません)。登録するには @実行 を 1 に書き換えて流し直してください。';
  RETURN;
END;

BEGIN TRANSACTION;

/* 全体共通の行は分類 4 段を NULL で持つ(4.4 の「空 = 上位の分類全体」)。 */
INSERT INTO [ug01].[Rep1_運報自動化_Editor_共通サンプル]
    ([カテゴリ], [大分類], [中分類], [小分類], [データJSON], [更新日時], [更新者])
  SELECT NULLIF([カテゴリ], N''), NULLIF([大分類], N''), NULLIF([中分類], N''), NULLIF([小分類], N''),
         N'{}', SYSUTCDATETIME(), N'移行'
    FROM @候補
    ORDER BY [順];

PRINT CONCAT(N'登録した行: ', @@ROWCOUNT);

COMMIT TRANSACTION;
GO
