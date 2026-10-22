# DB スキーマ / 適用 (フェーズ2)

SQL Server 2012 の `usrap.ug01`（既存 DB / 既存スキーマ）に、`Rep1_運報自動化_Editor_` 接頭辞でテーブルとストアドを作成する。本文(HTML/CSS)はファイル保存、DB はパーツ・認証・監査などのメタと、作成タブが読むファンド属性(同じサーバの `Rep1`。sproc から 3 部名で参照)のみ。テンプレートの台帳は持たない。版/スナップ/編集履歴は git(コミット履歴)、PDF出力/作成/パーツ変更はファイル監査ログ(logs/history/*.jsonl)が担う。

## 構成
```
ddl/    01_テーブル.sql 02_索引.sql 03_制約.sql   … 6 テーブル（冪等。テンプレート台帳は無い）
sproc/  template/series/user/session/part/sample/audit/noteMaster.sql
        … 1 ゲートウェイ sproc ごとに第1引数 @操作 で分岐（8 本）
        … usp_テンプレートは 委託会社一覧 / ファンド一覧、usp_シリーズは 一覧 のみ。どちらも Rep1 を
          3 部名で読み、テーブル名・列名は仮(sproc の中だけに書く)。一覧/取得/確定/下書きは git・ファイル
dev/    Rep1_検証用.sql(LocalDB に検証用の Rep1 を作る) / 台帳_削除.sql(旧テンプレート台帳の DROP)
        … apply.ps1 の対象外。必要なときに手で流す
migrate/ 共通サンプル_分類登録.sql(パーツカタログの分類から共通サンプルの行を値なしで作る)
        … apply.ps1 の対象外。本番は SSMS で開いて usrap に対して実行する。既定はプレビューで、
          `@実行` を 1 にして登録する。冪等
diag/    パーツ_Jinja構文調査.sql(内容HTML の Jinja 構文を数える。読み取りのみ。SSMS で usrap に対して実行)
         パーツ_Jinja引数調査.sql(テスト名・loop の属性・set の形を数える。読み取りのみ。SSMS で usrap に対して実行)
seed/   管理ユーザー.sql（生成物）/ パーツカタログ.sql / 共通サンプル.sql
apply.ps1  … ddl→sproc→seed を sqlcmd(-E -f 65001) で順に適用(-SkipSeed で seed を飛ばす)
```

すべての `.sql` は **UTF-8 BOM** で保存（日本語識別子 + sqlcmd の cp932 環境対策）。SQL Server 2012 互換のため `CREATE OR ALTER` / `OPENJSON` / `FOR JSON` / `STRING_AGG` は不使用（sproc は `DROP`+`CREATE`、JSON はテキスト保管で Node 側パース）。`THROW` の直前の文は `;` 終端が必須（T-SQL の構文規則。sproc 末尾の `END` の後に `THROW` を置く場合は `END;` と書く。2026-08 の LocalDB 実適用検証で全 sproc が「Incorrect syntax near 'THROW'」になった実績）。

## 適用手順
```powershell
# 1) seed SQL を生成（管理ユーザー / パーツカタログ / 共通サンプル）
corepack pnpm --filter server exec tsx scripts/hash-password.ts admin "<パスワード>" 管理者 admin
corepack pnpm --filter server exec tsx scripts/gen-seed.ts   # web フィクスチャ→seed SQL

# 2) スキーマ + sproc + seed を適用（Windows 統合認証）
powershell -ExecutionPolicy Bypass -File server\db\apply.ps1 -Server <host\instance>
```

本番では `-SkipSeed` を付けて ddl → sproc だけを流す。seed は開発・検証用の値で、本番に入れると共通サンプルの行が開発値で埋まり、migrate/ の登録が登録済みとして飛ばす（本番の手順は `docs/editor/src/デプロイ運用手順書.md` の 4.3 節）。

構築済みの検証 DB は、パーツカタログの行を消してから seed を流し直す（seed は既存行を上書きしないため、委託会社コードが NULL のまま残り一覧が空になる）。

## エラー番号 → AppError kind（`db/sproc.ts` が変換）
| SQL エラー | kind | HTTP |
|---|---|---|
| `THROW 50404` | not_found | 404 |
| `THROW 50409`, 2627/2601(一意制約) | conflict | 409 |
| `THROW 50000`（必須パラメタ不足など） | validation | 400 |
| その他 | unexpected | 500 |
