# DB スキーマ / 適用 (フェーズ2)

SQL Server 2012 の `usrap.ug01`（既存 DB / 既存スキーマ）に、`Rep1_運報自動化_Editor_` 接頭辞でテーブルとストアドを作成する。本文(HTML/CSS)はファイル保存、DB は台帳(作成可能カタログ)・パーツ・認証・監査などメタのみ。版/スナップ/編集履歴は git(コミット履歴)、PDF出力/作成/パーツ変更はファイル監査ログ(logs/history/*.jsonl)へ移行し、履歴テーブルと usp_履歴 は廃止した。

## 構成
```
ddl/    01_テーブル.sql 02_索引.sql 03_制約.sql   … 6 テーブル（冪等。履歴は廃止）
sproc/  template/user/session/part/sample/audit.sql
        … テーブル単位の 1 ゲートウェイ sproc（第1引数 @操作 で分岐）
        … usp_テンプレートは候補/系列/生成登録のみ（一覧/取得/確定/下書きは git・ファイルへ移行）
seed/   管理ユーザー.sql（生成物）/ パーツカタログ.sql / サンプルデータ.sql
apply.ps1  … ddl→sproc→seed を sqlcmd(-E -f 65001) で順に適用
```

すべての `.sql` は **UTF-8 BOM** で保存（日本語識別子 + sqlcmd の cp932 環境対策）。SQL Server 2012 互換のため `CREATE OR ALTER` / `OPENJSON` / `FOR JSON` / `STRING_AGG` は不使用（sproc は `DROP`+`CREATE`、JSON はテキスト保管で Node 側パース）。

## 適用手順
```powershell
# 1) seed SQL を生成（管理ユーザー / パーツカタログ / サンプルデータ）
corepack pnpm --filter server exec tsx scripts/hash-password.ts admin "<パスワード>" 管理者 admin
corepack pnpm --filter server exec tsx scripts/gen-seed.ts   # web フィクスチャ→seed SQL

# 2) スキーマ + sproc + seed を適用（Windows 統合認証）
powershell -ExecutionPolicy Bypass -File server\db\apply.ps1 -Server <host\instance>
```

## エラー番号 → AppError kind（`db/sproc.ts` が変換）
| SQL エラー | kind | HTTP |
|---|---|---|
| `THROW 50404` | not_found | 404 |
| `THROW 50409`, 2627/2601(一意制約) | conflict | 409 |
| `THROW 50000`（必須パラメタ不足など） | validation | 400 |
| その他 | unexpected | 500 |
