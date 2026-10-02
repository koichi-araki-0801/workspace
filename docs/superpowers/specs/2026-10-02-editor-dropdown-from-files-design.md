# editor: 候補ドロップダウンと系列をファイル起点へ（設計）

- 状態: 設計承認済み（2026-10-02）
- 前提の洗い出し: /dig（2026-10-02）

## 背景

編集タブの一覧（`listTemplates`）は 2026-09-11 の変更（46fef45）で、DB の台帳ではなく `filled/` と
`pending/` のファイル走査から作るようになった。一方、委託会社・ファンド・基準日・版種の候補
（`GET /api/templates/options`）は今も DB の台帳（`ug01.Rep1_運報自動化_Editor_テンプレート台帳`）から
作っている。台帳に行が入るのは editor の作成タブで生成したときだけなので、別ツールで `filled/` に
置いたテンプレートは一覧に出るのに候補には出ない。別環境ではこれで候補が空になった。

作成タブの系列（`GET /api/templates/series`。同じ会社・版種の既存テンプレート）も台帳から作って
いるが、「系列から作る」で生成器が読むのは `templates/<ID>.html` である。台帳にあっても
`templates/` に無ければ生成は失敗する。

## 決定事項

| 項目 | 決定 |
|---|---|
| 候補の出所 | 画面ごとに切り替える。編集タブ = `filled/` + `pending/`、比較・結合 = `filled/` だけ、作成タブ = 台帳（従来どおり） |
| 系列の出所 | `templates/` のファイル名走査。sproc `template` の `系列` 分岐は削除する |
| 大文字小文字 | 候補・一覧・系列の絞り込みとも区別しない |
| 差分パッチ | `SOURCE-COMMIT` が 2f88a2e の環境だけを対象にする。生成スクリプトは `local-only/` に残す |

作成タブの候補を台帳のまま残すのは、台帳が「作成できるテンプレートの一覧」の意味を持つため。
`filled/` から作ると、作成できるのが既に値入り HTML のあるファンドだけになる。

比較・結合で `pending/` を除くのは、両画面が呼び出し側で `status === 'published'` に絞っている
ため。候補に未承認分を混ぜると「選べるのに一覧が空」になる。

## 設計

### API

`GET /api/templates/options` にクエリ `scope` を加える。

| scope | 候補の出所 |
|---|---|
| `edit` | `filled/` + `pending/`（`filled/` にある id は `pending/` 側を除く。一覧と同じ規則） |
| `published` | `filled/` だけ |
| `create` | sproc `template` の `候補`（台帳） |

`scope` を省いたときは `create` として扱う。これは変更前と同じ動きで、外部から直接呼ぶ利用者の
挙動を変えないため。上記以外の値は 400（validation）にする。

`shared` に `DropdownScope`（`'edit' | 'published' | 'create'`）を加え、
`TemplateRepository.getDropdownOptions(query, scope)` で受ける。

### 画面

`SearchFilters.vue` に必須の prop `scope` を加える。必須にするのは、渡し忘れた画面が黙って
誤った候補を出すのを防ぐため。

| 画面 | scope |
|---|---|
| 編集タブ（`EditTabView.vue`） | `edit` |
| 比較（`CompareSideSelector.vue`） | `published` |
| 結合（`MergeTabView.vue`） | `published` |
| 作成タブ（`CreateTabView.vue`） | `create` |

### サーバ

- `listTemplates` の「`filled/` と `pending/` を走査して `TemplateMeta` を作る」部分を関数へ切り出し、
  一覧と候補（`edit` / `published`）で共用する。
- ファイル起点の候補は、sproc と同じく「自分より上位の選択だけで絞る」規則で作る（会社は絞らない、
  ファンドは会社で、基準日は会社・ファンドで、版種は会社・ファンド・基準日で絞る）。並び順は
  `localeCompare`。
- 大文字小文字を区別しない比較にする。対象は候補の絞り込み、一覧の `metaMatches`（サーバと local
  実装）、系列。大文字小文字だけが違う値は候補では 1 つにまとめ、最初に見つかった表記を出す。
- 系列（`listSeriesFunds`）は `templates/` のファイル名を走査し、会社・版種が一致するものを返す。
  並びはファンド → 基準日。`status` は `published`、`updatedAt` は `templates/` 側の更新時刻。
  `resolveFund`（シリーズファンドかどうかの判定）は web 側で同じ結果を使うので変更しない。
- sproc `template.sql` から `系列` 分岐を削除する。in-memory フェイク（`sprocFake`）とテストも合わせる。

### local モード

- `getDropdownOptions` は `scope = 'published'` のとき承認済みだけに絞る。`edit` と `create` は従来の
  fixtures 全件のまま。
- `metaMatches` を大文字小文字を区別しない比較にする。
- 系列はモック（`SERIES_FUND_CODES`）のまま変えない。

### 文書

- 設計書（`docs/editor/src/設計書.md`）の台帳・候補・系列の記述（2.1 節の DB の守備範囲、7 節の
  契約と永続先の図、route 対応表）を新しい出所に合わせる。
- DDL と sproc のコメントにある「候補/系列の源」を直す。
- デプロイ運用手順書に、更新時に `server\db\sproc\template.sql` を流し直す旨を書く。

## エラー処理

- `scope` の不正値は 400。
- `filled/` / `pending/` / `templates/` が無いときは、一覧と同じく空として扱う（エラーにしない）。
- ファイル名が規約外のファイルは、一覧と同じく黙って除く。

## テスト

- サーバ: `scope` ごとの候補（`edit` は `pending/` を含む、`published` は含まない、`create` は sproc を
  呼ぶ）、上位の選択だけで絞る規則、大文字小文字を区別しない照合と表記のまとめ、系列を
  `templates/` から作ること、`scope` の検査（不正値で 400、省略で `create`）。
- web: 各画面が正しい `scope` を渡すこと、local 実装の `published` 絞り込みと照合規則。
- 既存の影響テスト: `templates.routes.test.ts`、`sprocFake.test.ts`、`restRepos.dom.test.ts`。

## 差分パッチ

- `local-only/make-source-patch.py --base <コミット> --target <コミット>` を作る。前回（37f4c1a → 2f88a2e）の
  生成手順を一般化したもので、変更・追加ファイルを `git archive` した `files.zip`、`deleted.txt`、
  `MANIFEST` と `SOURCE-COMMIT`（target のもの）、`apply_patch.py` / `apply_patch.bat` / `README.txt` を出す。
- 今回は 2f88a2e → 実装後のコミットで作り、GitHub Release（prerelease）に上げる。
- `README.txt` には、適用後に `server\db\sproc\template.sql` を DB で流し直す手順を書く。流さなくても
  使われない分岐が残るだけで、動作には影響しない。
