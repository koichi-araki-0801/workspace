/* ============================================================================
 *  診断: パーツカタログの内容HTML で使われている Jinja の構文を数える(読み取り専用)
 *  editor の評価器(許可リスト方式)に足りない構文を見つけるための調査。出力は構文の種類・名前・
 *  件数・パーツ ID だけで、内容HTML の本文は出さない。結果はそのまま開発側へ渡してよい。
 *
 *  SSMS で開き、データベースに usrap を選んで実行する。結果タブに 1 表だけ出る。
 *  sqlcmd でも流せる: sqlcmd -S <host\instance> -d usrap -E -b -f 65001 -W -s "," -i <このファイル>
 *  何も書き込まない(SELECT とテーブル変数だけ)。UTF-8 BOM。SQL Server 2012 互換。
 *
 *  数え方は字面の走査なので厳密な構文解析ではない。文字列リテラルの中の `|` や ` is ` も拾う。
 *  拾い過ぎは開発側で見て捨てる前提で、取りこぼさない方へ倒している。
 * ==========================================================================*/

SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;  -- 集計の FOR XML … .value() が要る(sqlcmd の既定は OFF)

/* ── 1. タグの取り出し ──
 * `{{ … }}`(出力)と `{% … %}`(文)を先頭から順に拾う。`{# … #}`(コメント)は数えない。
 * 空白制御の `-`(`{%-` `-%}`)は本文の前後から落とす。 */
DECLARE @タグ TABLE (
  [パーツID] NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL,
  [種別]     NCHAR(1)     NOT NULL,  -- O = 出力 / S = 文
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

/* ── 2. 構文の取り出し ──
 * 文のキーワード / `|` の後のフィルタ名 / ` is ` の後のテスト名 / `(` の直前の名前(`.` が前に
 * あればメソッド、無ければ関数)。名前は英数字と `_` の並び。 */
DECLARE @構文 TABLE (
  [種類]     NVARCHAR(16) NOT NULL,
  [名前]     NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL,
  [パーツID] NVARCHAR(64) COLLATE Japanese_CI_AS NOT NULL
);

/* 文のキーワード(先頭の単語)。 */
INSERT INTO @構文 ([種類], [名前], [パーツID])
  SELECT N'文', LEFT(t.[本文], PATINDEX(N'%[^A-Za-z0-9_]%', t.[本文] + N' ') - 1), t.[パーツID]
    FROM @タグ AS t
    WHERE t.[種別] = N'S';

/* 区切り文字ごとの出現位置。`|` と `(` を本文の先頭から順に拾う。 */
;WITH marks AS (
  SELECT t.[パーツID], t.[本文] AS b, m.ch, CHARINDEX(m.ch, t.[本文], 1) AS pos
    FROM @タグ AS t
    CROSS JOIN (SELECT N'|' AS ch UNION ALL SELECT N'(') AS m
  UNION ALL
  SELECT [パーツID], b, ch, CHARINDEX(ch, b, pos + 1)
    FROM marks
    WHERE pos > 0
), hits AS (
  SELECT [パーツID], b, ch, pos FROM marks WHERE pos > 0
)
INSERT INTO @構文 ([種類], [名前], [パーツID])
  SELECT k.[種類], k.[名前], h.[パーツID]
    FROM hits AS h
    CROSS APPLY (
      /* `|` の後: 空白を飛ばして名前を読む */
      SELECT LTRIM(SUBSTRING(h.b, h.pos + 1, 128)) AS after,
             /* `(` の前: 空白を飛ばして逆向きに名前を読む */
             LTRIM(REVERSE(LEFT(h.b, CASE WHEN h.pos > 1 THEN h.pos - 1 ELSE 0 END))) AS before_rev
    ) AS w
    CROSS APPLY (
      SELECT CASE h.ch WHEN N'|' THEN N'フィルタ'
                       ELSE CASE WHEN SUBSTRING(w.before_rev,
                                        PATINDEX(N'%[^A-Za-z0-9_]%', w.before_rev + N' '), 1) = N'.'
                                 THEN N'メソッド' ELSE N'関数' END END AS [種類],
             CASE h.ch WHEN N'|' THEN LEFT(w.after, PATINDEX(N'%[^A-Za-z0-9_]%', w.after + N' ') - 1)
                       ELSE REVERSE(LEFT(w.before_rev,
                                         PATINDEX(N'%[^A-Za-z0-9_]%', w.before_rev + N' ') - 1)) END AS [名前]
    ) AS k
    CROSS APPLY (
      /* `(` の前の名前のさらに前(空白を飛ばした 1 文字目以降)。`|` ならフィルタの引数
       * (`x|format(2)`)で、フィルタとして数え済み。`macro ` なら macro の定義。どちらも呼び出しから外す。 */
      SELECT LTRIM(SUBSTRING(w.before_rev, LEN(k.[名前]) + 1, 128)) AS rest_rev
    ) AS r
    WHERE k.[名前] <> N''
      AND NOT (h.ch = N'(' AND (LEFT(r.rest_rev, 1) = N'|' OR LEFT(r.rest_rev, 5) = N'orcam'))
  OPTION (MAXRECURSION 0);

/* テスト: ` is ` / ` is not ` の後の名前。 */
;WITH marks AS (
  SELECT [パーツ_ID] = t.[パーツID], b = N' ' + t.[本文] + N' ', pos = CHARINDEX(N' is ', N' ' + t.[本文] + N' ', 1)
    FROM @タグ AS t
  UNION ALL
  SELECT [パーツ_ID], b, CHARINDEX(N' is ', b, pos + 1)
    FROM marks
    WHERE pos > 0
)
INSERT INTO @構文 ([種類], [名前], [パーツID])
  SELECT N'テスト', k.[名前], m.[パーツ_ID]
    FROM marks AS m
    CROSS APPLY (SELECT LTRIM(SUBSTRING(m.b, m.pos + 4, 128)) AS a1) AS w1
    CROSS APPLY (SELECT CASE WHEN LEFT(w1.a1, 4) = N'not ' THEN LTRIM(SUBSTRING(w1.a1, 5, 128))
                             ELSE w1.a1 END AS a2) AS w2
    CROSS APPLY (SELECT LEFT(w2.a2, PATINDEX(N'%[^A-Za-z0-9_]%', w2.a2 + N' ') - 1) AS [名前]) AS k
    WHERE m.pos > 0 AND k.[名前] <> N''
  OPTION (MAXRECURSION 0);

/* ── 3. 集計 ── */
SELECT c.[種類], c.[名前],
       COUNT(*)                    AS [件数],
       COUNT(DISTINCT c.[パーツID]) AS [パーツ数],
       STUFF((SELECT DISTINCT N', ' + d.[パーツID]
                FROM @構文 AS d
                WHERE d.[種類] = c.[種類] AND d.[名前] = c.[名前]
                FOR XML PATH(N''), TYPE).value(N'.', N'NVARCHAR(MAX)'), 1, 2, N'') AS [パーツID]
  FROM @構文 AS c
  GROUP BY c.[種類], c.[名前]
UNION ALL
SELECT N'(集計)', N'Jinja を含むパーツ', COUNT(DISTINCT [パーツID]), COUNT(DISTINCT [パーツID]), N''
  FROM @タグ
UNION ALL
SELECT N'(集計)', N'全パーツ', COUNT(*), COUNT(*), N''
  FROM [ug01].[Rep1_運報自動化_Editor_パーツカタログ]
ORDER BY 1, 2;
