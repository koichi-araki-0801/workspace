/* ============================================================================
 *  診断: パーツカタログの Jinja で、絞り込みフィルタに渡すテスト名・loop の属性・set の形を数える
 *  (読み取り専用)。`パーツ_Jinja構文調査.sql` の追加調査で、評価器に足すテストと文の形を決める。
 *  出力は種類・名前・件数・パーツ数・パーツ ID だけで、内容HTML の本文と文字列の値は出さない
 *  (テスト名は英数字と `_` の並びだけを出す)。
 *
 *  SSMS で開き、データベースに usrap を選んで実行する。結果タブに 1 表だけ出る。
 *  何も書き込まない(SELECT とテーブル変数だけ)。UTF-8 BOM。SQL Server 2012 互換。
 * ==========================================================================*/

SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;  -- 集計の FOR XML … .value() が要る(sqlcmd の既定は OFF)

/* ── 1. タグの取り出し(`パーツ_Jinja構文調査.sql` と同じ) ── */
DECLARE @タグ TABLE (
  [パーツID] NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL,
  [種別]     NCHAR(1)     NOT NULL,
  [本文]     NVARCHAR(MAX) COLLATE Japanese_CI_AS NOT NULL
);

;WITH src AS (
  SELECT [パーツID], [内容HTML] AS h
    FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
), scan AS (
  SELECT s.[パーツID], s.h, x.st, x.kind,
         CASE WHEN x.st = 0 THEN 0
              ELSE CHARINDEX(CASE x.kind WHEN N'O' THEN N'}}' ELSE N'%}' END, s.h, x.st + 2) END AS en
    FROM src AS s
    CROSS APPLY (SELECT CHARINDEX(N'{{', s.h, 1) AS a, CHARINDEX(N'{%', s.h, 1) AS b) AS p
    CROSS APPLY (SELECT CASE WHEN p.a = 0 THEN p.b WHEN p.b = 0 THEN p.a
                             WHEN p.a < p.b THEN p.a ELSE p.b END AS st,
                        CASE WHEN p.a <> 0 AND (p.b = 0 OR p.a < p.b) THEN N'O' ELSE N'S' END AS kind) AS x
  UNION ALL
  SELECT c.[パーツID], c.h, x.st, x.kind,
         CASE WHEN x.st = 0 THEN 0
              ELSE CHARINDEX(CASE x.kind WHEN N'O' THEN N'}}' ELSE N'%}' END, c.h, x.st + 2) END
    FROM scan AS c
    CROSS APPLY (SELECT CHARINDEX(N'{{', c.h, c.en + 2) AS a, CHARINDEX(N'{%', c.h, c.en + 2) AS b) AS p
    CROSS APPLY (SELECT CASE WHEN p.a = 0 THEN p.b WHEN p.b = 0 THEN p.a
                             WHEN p.a < p.b THEN p.a ELSE p.b END AS st,
                        CASE WHEN p.a <> 0 AND (p.b = 0 OR p.a < p.b) THEN N'O' ELSE N'S' END AS kind) AS x
    WHERE c.st > 0 AND c.en > 0
)
INSERT INTO @タグ ([パーツID], [種別], [本文])
  SELECT [パーツID], kind, SUBSTRING(h, st + 2, CASE WHEN en > st + 2 THEN en - st - 2 ELSE 0 END)
    FROM scan
    WHERE st > 0 AND en > 0
  OPTION (MAXRECURSION 0);

UPDATE @タグ SET [本文] = LTRIM(RTRIM([本文]));
UPDATE @タグ SET [本文] = LTRIM(SUBSTRING([本文], 2, LEN([本文]))) WHERE LEFT([本文], 1) = N'-';
UPDATE @タグ SET [本文] = RTRIM(LEFT([本文], LEN([本文]) - 1))    WHERE RIGHT([本文], 1) = N'-';

DECLARE @構文 TABLE (
  [種類]     NVARCHAR(32) NOT NULL,
  [名前]     NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL,
  [パーツID] NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL
);

/* ── 2. 絞り込みフィルタに渡すテスト名 ──
 * `select(` `reject(` は 1 つ目、`selectattr(` `rejectattr(` は 2 つ目の文字列引数がテスト名。
 * 引数の文字列が足りなければ `(なし)`(真偽で絞る形)。引用符は ' と " の両方を見る。 */
;WITH f AS (
  SELECT N'select' AS fn, 1 AS nth UNION ALL SELECT N'reject', 1
  UNION ALL SELECT N'selectattr', 2 UNION ALL SELECT N'rejectattr', 2
), marks AS (
  SELECT t.[パーツID], t.[本文] AS b, f.fn, f.nth,
         CHARINDEX(f.fn + N'(', t.[本文], 1) AS pos
    FROM @タグ AS t CROSS JOIN f
  UNION ALL
  SELECT [パーツID], b, fn, nth, CHARINDEX(fn + N'(', b, pos + 1)
    FROM marks
    WHERE pos > 0
), calls AS (
  /* 直前が `|`(空白を挟んでよい)のものだけ。`selectattr(` の中の `select(` の重複も
   * 直前の文字で落ちる(`select` の前が英字になる)。 */
  SELECT m.[パーツID], m.fn, m.nth,
         SUBSTRING(m.b, m.pos + LEN(m.fn) + 1,
                   CASE WHEN CHARINDEX(N')', m.b, m.pos) > m.pos + LEN(m.fn) + 1
                        THEN CHARINDEX(N')', m.b, m.pos) - m.pos - LEN(m.fn) - 1 ELSE 0 END) AS args
    FROM marks AS m
    WHERE m.pos > 0
      AND LEFT(LTRIM(REVERSE(LEFT(m.b, CASE WHEN m.pos > 1 THEN m.pos - 1 ELSE 0 END))), 1) = N'|'
), q AS (
  /* 引数の中の文字列リテラルを先頭から順に取り出す(1 つ目・2 つ目まで)。 */
  SELECT c.[パーツID], c.fn, c.nth, c.args, 1 AS k, o.st1, o.q1,
         CASE WHEN o.st1 = 0 THEN 0 ELSE CHARINDEX(o.q1, c.args, o.st1 + 1) END AS en1
    FROM calls AS c
    CROSS APPLY (SELECT CHARINDEX(N'''', c.args) AS a, CHARINDEX(N'"', c.args) AS d) AS p
    CROSS APPLY (SELECT CASE WHEN p.a = 0 THEN p.d WHEN p.d = 0 THEN p.a
                             WHEN p.a < p.d THEN p.a ELSE p.d END AS st1,
                        CASE WHEN p.a <> 0 AND (p.d = 0 OR p.a < p.d) THEN N'''' ELSE N'"' END AS q1) AS o
  UNION ALL
  SELECT q.[パーツID], q.fn, q.nth, q.args, q.k + 1, o.st1, o.q1,
         CASE WHEN o.st1 = 0 THEN 0 ELSE CHARINDEX(o.q1, q.args, o.st1 + 1) END
    FROM q
    CROSS APPLY (SELECT CHARINDEX(N'''', q.args, q.en1 + 1) AS a, CHARINDEX(N'"', q.args, q.en1 + 1) AS d) AS p
    CROSS APPLY (SELECT CASE WHEN p.a = 0 THEN p.d WHEN p.d = 0 THEN p.a
                             WHEN p.a < p.d THEN p.a ELSE p.d END AS st1,
                        CASE WHEN p.a <> 0 AND (p.d = 0 OR p.a < p.d) THEN N'''' ELSE N'"' END AS q1) AS o
    WHERE q.k < q.nth AND q.st1 > 0 AND q.en1 > 0
)
INSERT INTO @構文 ([種類], [名前], [パーツID])
  SELECT c.fn + N' のテスト', ISNULL(n.[名前], N'(なし)'), c.[パーツID]
    FROM calls AS c
    OUTER APPLY (
      SELECT TOP 1
             CASE WHEN q.st1 > 0 AND q.en1 > q.st1 + 1
                       AND PATINDEX(N'%[^A-Za-z0-9_]%', SUBSTRING(q.args, q.st1 + 1, q.en1 - q.st1 - 1)) = 0
                  THEN SUBSTRING(q.args, q.st1 + 1, q.en1 - q.st1 - 1)
                  ELSE N'(識別子でない文字列)' END AS [名前]
        FROM q
        WHERE q.[パーツID] = c.[パーツID] AND q.args = c.args AND q.fn = c.fn AND q.k = c.nth
          AND q.st1 > 0 AND q.en1 > 0
    ) AS n
  OPTION (MAXRECURSION 0);

/* ── 3. loop の属性(`loop.index` など) ── */
;WITH marks AS (
  SELECT t.[パーツID], t.[本文] AS b, CHARINDEX(N'loop.', t.[本文], 1) AS pos
    FROM @タグ AS t
  UNION ALL
  SELECT [パーツID], b, CHARINDEX(N'loop.', b, pos + 1)
    FROM marks
    WHERE pos > 0
)
INSERT INTO @構文 ([種類], [名前], [パーツID])
  SELECT N'loop の属性', LEFT(w.a, PATINDEX(N'%[^A-Za-z0-9_]%', w.a + N' ') - 1), m.[パーツID]
    FROM marks AS m
    CROSS APPLY (SELECT SUBSTRING(m.b, m.pos + 5, 64) AS a) AS w
    WHERE m.pos > 0
      AND (m.pos = 1 OR SUBSTRING(m.b, m.pos - 1, 1) LIKE N'[^A-Za-z0-9_.]')
      AND LEFT(w.a, PATINDEX(N'%[^A-Za-z0-9_]%', w.a + N' ') - 1) <> N''
  OPTION (MAXRECURSION 0);

/* ── 4. set の形 ──
 * `set a.b = …`(属性への代入)/ `set a = …`(代入)/ `set a, b = …`(複数の代入)/
 * `=` の無い `set a`(ブロックの代入。`endset` まで)。 */
INSERT INTO @構文 ([種類], [名前], [パーツID])
  SELECT N'set の形',
         CASE WHEN CHARINDEX(N'=', t.[本文]) = 0 THEN N'ブロックの代入'
              WHEN CHARINDEX(N'.', LEFT(t.[本文], CHARINDEX(N'=', t.[本文]))) > 0 THEN N'属性への代入'
              WHEN CHARINDEX(N',', LEFT(t.[本文], CHARINDEX(N'=', t.[本文]))) > 0 THEN N'複数の代入'
              ELSE N'代入' END,
         t.[パーツID]
    FROM @タグ AS t
    WHERE t.[種別] = N'S' AND LEFT(t.[本文], 4) = N'set ';

/* ── 5. for の形(`for a, b in …` の複数変数、`if` 付き、`recursive`) ── */
INSERT INTO @構文 ([種類], [名前], [パーツID])
  SELECT N'for の形', k.[名前], t.[パーツID]
    FROM @タグ AS t
    CROSS APPLY (
      SELECT N'複数の変数' AS [名前]
        WHERE CHARINDEX(N',', LEFT(t.[本文], CHARINDEX(N' in ', t.[本文] + N' in '))) > 0
      UNION ALL
      SELECT N'if で絞る' WHERE CHARINDEX(N' if ', t.[本文]) > CHARINDEX(N' in ', t.[本文]) AND CHARINDEX(N' in ', t.[本文]) > 0
      UNION ALL
      SELECT N'recursive' WHERE t.[本文] LIKE N'% recursive%'
    ) AS k
    WHERE t.[種別] = N'S' AND LEFT(t.[本文], 4) = N'for ';

/* ── 6. 集計 ── */
SELECT c.[種類], c.[名前],
       COUNT(*)                     AS [件数],
       COUNT(DISTINCT c.[パーツID]) AS [パーツ数],
       STUFF((SELECT DISTINCT N', ' + d.[パーツID]
                FROM @構文 AS d
                WHERE d.[種類] = c.[種類] AND d.[名前] = c.[名前]
                FOR XML PATH(N''), TYPE).value(N'.', N'NVARCHAR(MAX)'), 1, 2, N'') AS [パーツID]
  FROM @構文 AS c
  GROUP BY c.[種類], c.[名前]
ORDER BY 1, 2;
