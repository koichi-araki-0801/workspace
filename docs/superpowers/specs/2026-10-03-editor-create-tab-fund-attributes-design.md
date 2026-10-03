# editor: 作成タブの候補をファンド属性テーブル起点へ（設計）

- 状態: 設計承認済み（2026-10-03。計画レビュー（/dig・Fable）後の確認で画面と会社コードの扱いを改訂）
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
| 属性テーブルの読み方 | usrap の sproc の中で `Rep1.dbo.…` を 3 部名で SELECT する（却下済み設計 #12「sproc ゲートウェイ外の直接 SQL」を守る）。Rep1 は usrap と同じサーバにあり、実行アカウントは既に読める |
| 会社コード | Rep1 の `委託会社コード` とファイル名の会社コード（`smtam` / `AM01` など）は書式が違う。`Rep1_投委託会社` の略称の列がファイル名の会社コードに当たる。editor 内の `companyCode`（`TemplateAttributes`）は従来どおりファイル名の会社コード（＝略称）で、Rep1 のコードは `rep1CompanyCode` として別に持つ |
| 取得の時期 | 委託会社は作成タブを開いたとき、ファンドは会社を選んだときに `WHERE 委託会社コード = @委託会社コード` で一括取得 |
| 画面 | 今の作成タブと同じ。Step 1 は委託会社 → ファンド → 版種の連動プルダウン、Step 2 は「属性から新規作成」「シリーズから作成」のカード |
| 名称での絞り込み | 共通の入力部品（Combobox）を、値（コード）の前方一致に加えて表示名の部分一致でも絞れるようにする（編集タブのファンド欄にも効く） |
| 版種 | 交付版 / 全体版の 2 択（プルダウンで 1 つ） |
| 作成済み | 3 つがそろったとき、選んだ会社・ファンド・版種のテンプレートがテンプレートフォルダ（`templates/`）にあれば Step 2 に「作成済み」の注意を出す。基準日は問わない（テンプレートは基準日で使い回さない）。`filled/`・`pending/` は見ない。作成は止めない |
| 系列 | 新しいゲートウェイ `usp_シリーズ` でシリーズを引く（SQL は仮）。シリーズのファンドを選ぶと、コピー元（選んだファンド）とコピー先（今回作るファンド）を生成器へ渡す。コピー元のテンプレートが無い候補は警告し、作成ボタンを押せなくする |
| 償還 | チェックボックスを残し、生成器へのパラメータとして渡す |
| 生成器 | editor は新しいパラメータ（`sourceFundCode`・`isRedemption`）を渡すだけ。本番の生成器は別途改修される |
| 台帳 | `候補`・`生成登録`・テンプレート台帳テーブルを削除する（読む処理が無くなるため） |
| 列名と型 | 仮の列名で作り、sproc の中だけに閉じる。返す列は `RTRIM(CAST(… AS NVARCHAR(n)))` で文字列化と末尾空白の除去をする（CHAR 型でも作成が 400 で止まらないように） |
| 検証 | LocalDB に検証用の `Rep1` DB を作り、実際の sproc が別 DB を読めることを確かめる |
| 差分パッチ | e82a5c2（別環境に適用済み）→ 実装後のコミットの 1 本を GitHub Release に上げる |

## 設計

### DB

`usp_テンプレート`（`server/db/sproc/template.sql`）の `@操作`:

| @操作 | 内容 |
|---|---|
| `委託会社一覧` | `Rep1.dbo.Rep1_投委託会社` から `委託会社コード`・`委託会社名`・`委託会社略称` を全件、コード順で返す |
| `ファンド一覧` | `Rep1.dbo.Rep1_投信ファンド属性` から `WHERE 委託会社コード = @委託会社コード` で `ファンドコード`・`ファンド名` を、コード順で返す。`@委託会社コード` が NULL なら THROW |

`候補` と `生成登録` は削除する。

新しいゲートウェイ `usp_シリーズ`（`server/db/sproc/series.sql`）:

| @操作 | 内容 |
|---|---|
| `一覧` | `Rep1.dbo.Rep1_投信ファンド属性` から `WHERE 委託会社コード = @委託会社コード` で `ファンドコード`・`シリーズコード` を返す。シリーズに属さないファンドは `シリーズコード` が NULL。`@委託会社コード` が NULL なら THROW |

仮の列名: `委託会社コード`・`委託会社名`・`委託会社略称`・`ファンドコード`・`ファンド名`・`シリーズコード`。
テーブル名・列名は sproc の中だけに書き、Node 側は sproc が返す列名（この 6 つで固定）だけを見る。実際の
列名が違う場合は sproc の SELECT に別名（`AS`）を付けて合わせる。

テンプレート台帳テーブルは DDL（`01_テーブル.sql`・`02_索引.sql`・`03_制約.sql`）から外す。既存環境の
テーブルは自動では消さない（`server/db/dev/台帳_削除.sql` を任意で流す）。

権限: Rep1 は usrap と同じサーバにあり、実行アカウントは既に読める。手順書には確認方法（sproc を実行して
行が返ること）と、読めないとき（汎用の DB エラーが出る）に疑う点（Rep1 側の SELECT 権限。DB をまたぐ参照は
所有権の連鎖が既定で効かない）だけを書く。

検証用: `server/db/dev/Rep1_検証用.sql` に、LocalDB へ `Rep1` DB・2 テーブル・数件のデータを作る SQL を置く
（`apply.ps1` の対象外）。

### API

| ルート | 内容 |
|---|---|
| `GET /api/templates/companies` | `[{ companyCode, companyName, rep1CompanyCode }]`。`companyCode` は略称（ファイル名の会社コード） |
| `GET /api/templates/funds?rep1CompanyCode=…` | `[{ fundCode, fundName }]`。`rep1CompanyCode` は必須 |
| `GET /api/templates/creatable?companyCode=…&rep1CompanyCode=…&fundCode=…&editionType=…` | `{ created, seriesFunds }`。4 つとも必須 |

- `created`: その会社（略称）・ファンド・版種のテンプレートが `templates/` にあるか（基準日は問わない。照合は
  大文字小文字を区別しない）。
- `seriesFunds`: 同じシリーズコードの他のファンドの `[{ fundCode, fundName, hasTemplate }]`（シリーズから
  作成のコピー元の候補）。ファンドコード順。シリーズに属さないファンドは空配列。`hasTemplate` は、
  コピー元のテンプレートが `templates/` に同じ会社（略称）・版種で 1 件以上あるか。無いファンドも候補には
  出す（画面で警告して作成を止める）。
- 必須のクエリが無い・空のときは 400。値は `assertTemplateAttributeToken` で検査する（区切り文字などは 400）。
- 削除: `GET /api/templates/series`、`TemplateRepository.resolveFund` / `listSeriesFunds`、`FundResolution`、
  `GET /api/templates/options` の `scope=create`（`scope` 省略時は `edit`）、`DROPDOWN_SCOPES` の `create`。
- 生成（`POST /api/generate`）: 台帳への登録をやめる。`GenerateRequest.basedOnTemplateId` を
  `sourceFundCode`（コピー元のファンドコード。会社と版種はコピー先と同じ）に置き換える。生成器へ渡す JSON は
  コピー先の属性（`companyCode`・`fundCode`・`baseDate`・`editionType`）に、`sourceFundCode`（シリーズから作成の
  ときだけ）と `isRedemption`（true のときだけ）を加える。`sourceFundCode` はルートと `generateTemplate` の
  両方で検査する。コピー元のテンプレートが `templates/` に無ければ 400。作成履歴には `sourceFundCode` を記録する
  （既存の履歴ファイルにある `basedOnTemplateId` は読めるように optional で残す）。テスト用の偽の生成器は、
  `templates/` にあるコピー元ファンド（同じ会社・版種）の基準日が最新のテンプレートを読む（基準日はファイル名
  から取り出して比べる）。

`shared` に `CompanyOption`・`FundOption`・`SeriesFundOption`・`CreatableInfo` の Zod スキーマを置き、
`TemplateRepository` に `listCompanies()`・`listFunds(rep1CompanyCode)`・
`getCreatableInfo(companyCode, rep1CompanyCode, fundCode, editionType)` を足す。

### 画面（作成タブ）

今の作成タブと同じ構成。`SearchFilters` は使わず（候補の出所が違うため）、同じ見た目の部品
（`FilterBar`・`FormField`・`Combobox`・`Select`）で Step 1 を組む。

- Step 1: 委託会社（Combobox。表示は会社名、値は略称）→ ファンド（Combobox。表示は「コード 名称」）→
  版種（Select。交付版 / 全体版）。左が未選択なら右は選べない。会社を変えたらファンドと版種を消す。
  URL クエリ（`companyCode`・`fundCode`・`editionType`）と同期する。
- 3 つがそろったら `getCreatableInfo` を呼ぶ（古い応答は捨てる）。
- Step 2:
  - `created` なら「この会社・ファンド・版種のテンプレートは作成済みです。」の
    注意を出す（作成は止めない）。
  - 償還のチェックボックス（今と同じ位置）。
  - 「属性から新規作成」カード: 押すと作成して編集画面へ（今と同じ）。
  - 「シリーズから作成」カード: `seriesFunds` が空でないときだけ出す。押すと候補一覧（ファンドコード・
    ファンド名・状態・作成ボタン）を出す。`hasTemplate` が false の行は状態に「コピー元のテンプレートが
    ありません」と警告を出し、作成ボタンを disabled にする。作成ボタンでコピー元のファンドコードを付けて作成する。
- 作成後の遷移は従来どおり作成経路の編集画面（`editorRoute(id, { created: true })`）。

### local モード

`listCompanies` は fixtures のファンド表（`funds.json`）の会社を重複なしで（`companyCode` と
`rep1CompanyCode` はどちらも fixtures の会社コード）、`listFunds` はその会社のファンドを返す。
`getCreatableInfo` の `created` は local のテンプレート一覧から、`seriesFunds` は既存のモック
（`SERIES_FUND_CODES`）から作る。local の生成は、コピー元ファンドの最新テンプレートの HTML を写す。

### 文書

- 設計正典: 「DB=台帳」の記述を「DB はパーツ・認証・監査・注記マスタと、ファンド属性（Rep1）の参照」に直す。
  sproc は 8 本（`usp_シリーズ` 追加）。却下済み設計 #12 の範囲で Rep1 を読むこと、会社コードは略称を使うことを
  書く。`.claude/rules/design-canon-summary.md` も合わせて `--update` する。
- 設計書、仕様一覧、デプロイ運用手順書（DB 適用・Rep1 の確認・台帳の DROP・3.3 節）、手引き（作成タブ）。

## エラー処理

- `companies` / `funds` / `creatable` の DB エラーは既存の sproc エラー変換（`mapSqlError`）に任せ、画面は
  トーストで出す。
- `templates/`・`filled/`・`pending/` が無いときは空として扱う（`created` は false、`hasTemplate` は false）。
- シリーズから作成でコピー元テンプレートが無いときは、画面で作成を押せず、API でも 400 で止める。
- `usp_シリーズ` に行が無いファンドは、シリーズに属さないものとして扱う。

## テスト

- サーバ: `listCompanies`（略称と Rep1 コードの対応）、`listFunds`、`getCreatableInfo`（`created` の判定を
  3 つの置き場それぞれで、大文字小文字を区別しない照合、`seriesFunds` が同じシリーズの他ファンドだけで自分を
  含まないこと、並び、シリーズ無しは空、シリーズ一覧に行が無いファンド、`hasTemplate` の判定）、ルートの 400、
  `sourceFundCode` と `isRedemption` が生成器の JSON に入ること（無いときは入らないこと）、`sourceFundCode` の
  検査（規約外は 400、コピー元テンプレートが無ければ 400）、生成が台帳を呼ばないこと、`scope=create` の 400。
- sprocFake: `委託会社一覧`（略称を含む）・`ファンド一覧`・`usp_シリーズ 一覧` を足し、`候補`・`生成登録` を
  消す。会社コードの比較は大文字小文字を区別しない（実 DB の照合順序に合わせる）。
- web: rest の URL、local の 3 メソッド、Combobox の名称での絞り込み、作成タブの Step 2（作成済みの注意、
  シリーズ候補の警告と disabled）。
- e2e と手引きの撮影を合わせる。
- LocalDB: 検証用 `Rep1` を作り、実 sproc で会社（略称付き）・ファンド・シリーズが返ることを確かめる。

## 差分パッチ

- `local-only/make-source-patch/make_source_patch.py --base e82a5c2 --target <実装後>` で作り、
  GitHub Release（prerelease）に上げる。
- README の手順（起動より前に行う）: sproc 2 本の仮のテーブル名・列名を実際の名前に合わせる →
  `template.sql` と `series.sql` を DB で流す → editor を起動する。任意で台帳テーブルの DROP。
