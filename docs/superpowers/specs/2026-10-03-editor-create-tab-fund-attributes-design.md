# editor: 作成タブをファンド属性テーブル起点の一覧へ（設計）

- 状態: 設計承認済み（2026-10-03）
- 前提の洗い出し: /dig（2026-10-03）
- 前段: `2026-10-02-editor-dropdown-from-files-design.md`（作成タブだけ台帳を残した判断を、本書で覆す）

## 背景

作成タブの候補（委託会社・ファンド・版種）は、DB のテンプレート台帳（`usp_テンプレート` の `候補`）から
作っている。台帳に行が入るのは作成タブで生成したときだけなので、「一度作ったものしか候補に出ない」。
新しいファンドのテンプレートを作るには、既存のファンド属性テーブル（`Rep1.dbo.Rep1_投信ファンド属性`、
`Rep1.dbo.Rep1_投委託会社`）を参照する必要がある。

## 決定事項

| 項目 | 決定 |
|---|---|
| 属性テーブルの読み方 | usrap の sproc（`usp_テンプレート`）の中で `Rep1.dbo.…` を 3 部名で SELECT する（却下済み設計 #12「sproc ゲートウェイ外の直接 SQL」を守る） |
| 取得の時期 | 委託会社は作成タブを開いたとき、ファンドは会社を選んで検索したときに `WHERE 委託会社コード = @委託会社コード` で一括取得 |
| 画面 | 編集タブの連動プルダウン＋表の形を保つ。上段で委託会社（会社名で表示、値はコード）と版種（交付版 / 全体版の 1 つ）を選び、下段にファンドの表 |
| 版種 | プルダウンで 1 つだけ選ぶ（両方を一度に作らない） |
| 作成済み | 表に出し、選んだ版種のテンプレートがあれば「作成済み」と表示する。作成は止めない |
| 系列 | 新しいゲートウェイ `usp_シリーズ` で系列（シリーズ）を引く。SQL は仮。シリーズのファンドを選ぶと、コピー元（選んだファンド）とコピー先（今回作るファンド）を Python に渡す |
| 償還 | チェックボックスを残し、生成器（Python）へのパラメータとして渡す |
| 台帳 | `候補`・`生成登録`・テンプレート台帳テーブルを削除する（読む処理が無くなるため） |
| 列名 | 仮の列名で作り、sproc の中だけに閉じる。実際の列名が分かったら sproc を直す |
| 検証 | LocalDB に検証用の `Rep1` DB を作り、実際の sproc が別 DB を読めることを確かめる |
| 差分パッチ | e82a5c2（別環境に適用済み）→ 実装後のコミットの 1 本を GitHub Release に上げる |

## 設計

### DB

`usp_テンプレート`（`server/db/sproc/template.sql`）の `@操作`:

| @操作 | 内容 |
|---|---|
| `委託会社一覧` | `Rep1.dbo.Rep1_投委託会社` から `委託会社コード`・`委託会社名` を全件、コード順で返す |
| `ファンド一覧` | `Rep1.dbo.Rep1_投信ファンド属性` から `WHERE 委託会社コード = @委託会社コード` で `ファンドコード`・`ファンド名` を、コード順で返す。`@委託会社コード` が NULL なら THROW |

`候補` と `生成登録` は削除する。

新しいゲートウェイ `usp_シリーズ`（`server/db/sproc/series.sql`）:

| @操作 | 内容 |
|---|---|
| `一覧` | `Rep1.dbo.Rep1_投信ファンド属性` から `WHERE 委託会社コード = @委託会社コード` で `ファンドコード`・`シリーズコード` を返す。シリーズに属さないファンドは `シリーズコード` が NULL。`@委託会社コード` が NULL なら THROW |

仮の列名: `委託会社コード`・`委託会社名`・`ファンドコード`・`ファンド名`・`シリーズコード`。テーブル名・列名は
sproc の中だけに書き、Node 側は sproc が返す列名（上の仮の名前で固定）だけを見る。実際の列名が違う場合は
sproc の SELECT に別名（`AS`）を付けて合わせる。

テンプレート台帳テーブルは DDL（`01_テーブル.sql`・`02_索引.sql`・`03_制約.sql`）から外す。既存環境の
テーブルは自動では消さない（手順書に、不要なら手で DROP する SQL を書く）。

権限: DB をまたぐ参照では所有権の連鎖が既定で効かないため、editor を動かすアカウント（Windows 統合認証）に
`Rep1` の 2 テーブルへの SELECT 権限が要る。手順書とパッチの README に書く。

検証用: `server/db/dev/Rep1_検証用.sql` に、LocalDB へ `Rep1` DB・2 テーブル・数件のデータを作る SQL を置く
（`apply.ps1` の対象外）。

### API

| ルート | 内容 |
|---|---|
| `GET /api/templates/companies` | `[{ companyCode, companyName }]` |
| `GET /api/templates/funds?companyCode=…&editionType=…` | `[{ fundCode, fundName, created, seriesFunds }]`。`companyCode` と `editionType` は必須（無ければ 400） |

- `created`: 選んだ版種で、その会社・ファンドのテンプレートが `filled/`・`templates/`・`pending/` のどこかに
  あるか（基準日は問わない。照合は大文字小文字を区別しない）。
- `seriesFunds`: 同じシリーズコードの他のファンドの `[{ fundCode, fundName }]`（「系列から作成」のコピー元に
  できるもの）。ファンドコード順。シリーズに属さないファンドは空配列。`templates/` の有無では絞らない
  （コピー元のテンプレートをどこから読むかは生成器が決める）。
- 削除: `GET /api/templates/series`、`TemplateRepository.resolveFund` / `listSeriesFunds`、
  `GET /api/templates/options` の `scope=create`（`scope` 省略時は `edit`）、`DROPDOWN_SCOPES` の `create`。
- 生成（`POST /api/generate`）: 台帳への登録をやめる。`GenerateRequest` の `basedOnTemplateId` を
  `sourceFundCode`（コピー元のファンドコード。会社と版種はコピー先と同じ）に置き換える。生成器へ渡す JSON は
  コピー先の属性（`companyCode`・`fundCode`・`baseDate`・`editionType`）に、`sourceFundCode`（系列から作成の
  ときだけ）と `isRedemption`（true のときだけ）を加える。作成履歴の「元テンプレ」も `sourceFundCode` を記録する。
  テスト用の偽の生成器は、`templates/` にあるコピー元ファンド（同じ会社・版種）の基準日が最新のテンプレートを
  読む。

`shared` に `CompanyOption`（`companyCode`・`companyName`）と `CreatableFund`（上の 4 項目）の Zod スキーマを
置き、`TemplateRepository` に `listCompanies()` と `listCreatableFunds(companyCode, editionType)` を足す。
`CreatableFund.seriesFunds` の要素は `{ fundCode, fundName }`。

### 画面（作成タブ）

編集タブ（`SearchFilters` ＋ `TemplateTable`）と同じ構成を保つ。

- 上段: 委託会社（Combobox。表示は `companyName`、値は `companyCode`）、版種（Select。交付版 / 全体版）、
  償還のチェックボックス、検索ボタン。会社と版種がそろうまで検索は押せない。
- 下段: ファンドの表。列は「ファンドコード」「ファンド名」「状態」（`created` なら「作成済み」）「操作」。
  - 「作成」: その会社・ファンド・版種で新規作成する。
  - 「系列から作成」: `seriesFunds` が空でないときだけ出す。コピー元のファンド（選択肢は `seriesFunds`）を
    選ばせてから作成する。
- 作成後の遷移は従来どおり作成経路の編集画面（`editorRoute(id, { created: true })`）。
- URL クエリ同期（`companyCode`・`editionType`）は編集タブと同じく保つ。

### local モード

`listCompanies` は fixtures のファンド表（`funds.json`）の会社を重複なしで、`listCreatableFunds` はその会社の
ファンドを返す。`created` は local のテンプレート一覧から、`seriesFunds` は既存のモック
（`SERIES_FUND_CODES`）から作る。local の生成は、コピー元ファンドの最新テンプレートの HTML を写す。

### 文書

- 設計正典: 「DB=台帳」の記述を「DB はパーツ・認証・監査・注記マスタと、ファンド属性（Rep1）の参照」に直す。
  sproc は 8 本（`usp_シリーズ` 追加）。却下済み設計 #12 の範囲で Rep1 を読むことを書く。
  `.claude/rules/design-canon-summary.md` も合わせて `--update` する。
- 設計書（2.1 節・7 節の図・9.2 節・作成タブの節）、仕様一覧（画面項目・API・DB テーブル・sproc 表）、
  デプロイ運用手順書（DB 適用・Rep1 の権限・台帳の DROP・3.3 節）、手引き（作成タブの画面と撮影）。

## エラー処理

- `companies` / `funds` の DB エラーは既存の sproc エラー変換（`mapSqlError`）に任せ、画面はトーストで出す。
- `funds` の `companyCode` / `editionType` 欠落は 400。
- `templates/`・`filled/`・`pending/` が無いときは空として扱う（`created` は false）。
- 「系列から作成」で生成器がコピー元を見つけられないときは、生成器のエラーとして既存の経路で返す。

## テスト

- サーバ: `listCompanies`・`listCreatableFunds`（`created` の判定を 3 つの置き場それぞれで、大文字小文字を
  区別しない照合、`seriesFunds` が同じシリーズの他ファンドだけで自分を含まないこと、並び、シリーズ無しは空）、
  ルートの 400、`sourceFundCode` と `isRedemption` が生成器の JSON に入ること（無いときは入らないこと）、
  `sourceFundCode` の検査（規約外は 400）、生成が台帳を呼ばないこと、`scope=create` の 400。
- sprocFake: `委託会社一覧`・`ファンド一覧`・`usp_シリーズ 一覧` を足し、`候補`・`生成登録` を消す。
- web: rest の URL、local の `listCompanies` / `listCreatableFunds`、作成タブの画面（会社と版種で検索 →
  表 → 作成 / 系列から作成）。
- e2e と手引きの撮影を新しい画面に合わせる。
- LocalDB: 検証用 `Rep1` を作り、実 sproc で会社・ファンド・シリーズが返ることを確かめる。

## 差分パッチ

- `local-only/make-source-patch/make_source_patch.py --base e82a5c2 --target <実装後>` で作り、
  GitHub Release（prerelease）に上げる。
- README の追記: `template.sql` と `series.sql` を DB で流す、`Rep1` の SELECT 権限を付ける、仮の列名を
  実際の列名に合わせる箇所（sproc 2 本）、台帳テーブルを消したい場合の DROP。
