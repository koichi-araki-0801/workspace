# editor: テンプレート(templates/)のファイル名から基準日を外す（設計）

- 状態: 設計承認済み（2026-10-03）
- 前提の洗い出し: /dig（2026-10-03）
- 前段: `2026-10-03-editor-create-tab-fund-attributes-design.md`（作成タブの候補の Rep1 起点化。作成済みの判定は
  既に「templates/ にあれば。基準日は問わない」へ改めた）

## 背景

テンプレート（作成タブで作る Jinja のひな型。`templates/`）は基準日で使い回すものではない。1 つの
会社・ファンド・版種に 1 つあればよく、ファイル名に基準日は要らない。一方、値入り HTML（編集タブの本文。
`filled/`）は基準日ごとに別物で、ファイル名に基準日を持つ。

今は 1 つのテンプレート ID（`会社_ファンド_基準日_版種`）が `filled/`・`templates/`・`pending/`・下書き・メモ・
申請のすべてで同じテンプレートを指している。テンプレート側だけ基準日を外すと、この前提が崩れ、ID の形が
2 種類になる。

## 決定事項

| 項目 | 決定 |
|---|---|
| 範囲 | `templates/` のファイル名だけ基準日を外す（`会社_ファンド_版種.html`）。`filled/` は `会社_ファンド_基準日_版種.html` のまま |
| ID の区別 | 形で見分ける。3 つ区切り = テンプレート、4 つ区切り = 値入り HTML |
| 移行 | 不要（別環境の `templates/` にファイルが無い） |
| ペア同期 | テンプレート側（作成タブの承認）も同期する。状態ファイルは `filled/` 側と分ける（却下済み設計 #46 を改訂） |
| 作り直し | 同じ ID の承認待ちの申請があれば生成を止める。無ければ同じ ID の下書きと `pending/` を捨ててから生成する |
| 作成済みの修正 | 作成タブで作成済みを選ぶと「既存のテンプレートを開く」を出し、作成経路の編集画面 → 申請 → 承認で `templates/` を上書きする |
| 生成器 | 基準日を渡さない。コピー元は `templates/会社_コピー元_版種.html` |
| 基準日の表示 | 基準日を持たないテンプレートを開いているときは、編集画面の基準日の項目を丸ごと隠す。一覧の表は空欄 |

## 設計

### ID とファイル名（shared `domain/template.ts`）

- 2 つの形を名前で区別する。
  - 値入り（4 つ区切り）: 既存の `TEMPLATE_FILENAME_RE` / `parseTemplateFileName` / `templateFileName` は
    4 つ区切り専用のまま残す（`filled/` と既存の呼び出し元のため）。
  - テンプレート（3 つ区切り）: `SKELETON_FILENAME_RE` / `parseSkeletonFileName` / `skeletonFileName`
    （`会社_ファンド_版種.html`）を足す。
  - どちらの形も受ける入口（`pending/`・下書き・メモ・申請・履歴の id）用に、`parseAnyTemplateFileName`
    （3 つ区切りなら `baseDate` 無しの属性）と `isValidAnyTemplateId` / `assertAnyTemplateId` を足す。
    既存の `isValidTemplateId` / `assertTemplateId` を使っている入口は、受ける形に応じて置き換える。
- `TemplateAttributes.baseDate` は省略可（`z.string().optional()`）にする。テンプレート側は持たない。
- `templateIdFromFileName` は形を問わず `.html` を外す。
- ペア: `pairedTemplateId` は両方の形で版種だけを入れ替える。`templatePairKey` はテンプレートなら
  `会社_ファンド`、値入りなら `会社_ファンド_基準日`。`isValidPairKey` は 2 つ区切りと 3 つ区切りを受ける。
- 照合用の `attrKey` / `templateAttrKeys`（作成済み・コピー元の判定）は、テンプレート側を 3 つ区切りとして解析
  する。旧形式（4 つ区切り）の `templates/` ファイルは、作成済み・コピー元の判定にも一覧にも数えない（移行不要の前提）。

### 置き場ごとの規則（server `files/`）

| 置き場 | 受ける ID |
|---|---|
| `templates/`（`templatePath` / `listTemplateFiles` など） | 3 つ区切りだけ |
| `filled/`（`filledPath` など） | 4 つ区切りだけ |
| `pending/`・`drafts/`・`notes/`・`reviews/`・作成履歴 | どちらの形も |

パスを組み立てる関数が受ける形を強制する（検査を呼び出し側に任せない、という既存の不変則のまま）。

### 生成（`POST /api/generate`）

- ID は `skeletonFileName({ companyCode, fundCode, editionType })` から作る。サーバの基準日は使わない。
- 生成の前に順に確かめる。
  1. `templates/<ID>.html` がある → 409「作成済みです。既存のテンプレートを開いてください」
  2. 同じ ID の承認待ちの申請（origin=create）がある → 409「申請中です。承認か却下を待ってください」
  3. どちらも無い → 同じ ID の下書き（`drafts/`）と `pending/` を消してから生成し、`pending/<ID>.html` に置く。
- 生成器へ渡す JSON は `companyCode`・`fundCode`・`editionType` と、あれば `sourceFundCode`・`isRedemption`。
  `baseDate` は渡さない。
- テスト用の偽の生成器は、`sourceFundCode` があれば `TEMPLATES_DIR/会社_コピー元_版種.html`（会社コードの
  大文字小文字は問わない）を写す。
- 作成履歴の `attributes` は `baseDate` を持たない。

### 作成済みのテンプレートを直す（作成タブ）

- `CreatableInfo` に `templateId`（`会社_ファンド_版種`。作成済みのときだけ）を足す。
- Step 2 で作成済みなら「既存のテンプレートを開く」ボタンを出す。押すと `editorRoute(templateId, { created: true })`
  で作成経路の編集画面を開く（差し込み値のハイライトあり）。申請は origin=create、承認で `templates/` を上書きする。
- 「属性から新規作成」「シリーズから作成」は、作成済みのときは押せない（押しても 409 になるため）。

### 取得と一覧

- `getTemplate(id)`: 3 つ区切りなら `templates/` → `pending/`、4 つ区切りなら `filled/` → `pending/` の順に探す。
  どちらでもない形は 404。
- 編集タブの一覧（`listTemplates`）と候補は、今と同じく `filled/` + `pending/`。`pending/` の 3 つ区切りの行は
  基準日を持たない。候補の基準日の列には空の値を入れない。
- 比較・結合は `published`（`filled/`）だけなので影響しない。

### 申請と承認

- `ReviewRequest.attributes.baseDate` は省略可。origin=create の申請は 3 つ区切りの ID、origin=edit は 4 つ区切り。
- 確定書込（`confirmedWrite`）は、`target=templates` なら 3 つ区切り、`target=filled` なら 4 つ区切りだけを受ける。
  `filled` の基準（baseline）取得で同じ ID の `templates/` を代わりに読む経路は、ID の形が違うので使わない。

### ペア同期

- テンプレート側（作成の承認）も、交付版⇄全体版のパーツを同期する。ペアの ID は `pairedTemplateId` で求める
  （3 つ区切りなら 3 つ区切りのペア）。
- 状態ファイルは `sync/<pairKey>.json`。テンプレート側は `sync/会社_ファンド.json`、値入り側は
  `sync/会社_ファンド_基準日.json` で、自然に別ファイルになる。
- 設計正典の却下済み設計 #46「ペア同期の状態ファイルを `filled/` と `templates/` で分ける: しない」を、
  「テンプレートのファイル名から基準日を外したことに伴い、キーが別になるので分ける」へ改訂する。

### 画面

- 基準日を持たないテンプレート（3 つ区切り）を開いているときは、編集画面のヘッダ（`EditorTopBar`）と属性の欄
  （`AttributeBar` など）から基準日の項目を丸ごと隠す。
- 一覧の表（`TemplateTable`）では基準日の欄を空欄にする。
- 共通サンプルの `report.baseDate` など、Jinja の差し込み値としての基準日は今のまま（表示用の値）。

### local モード

- 生成の ID は 3 つ区切り。作成済み・コピー元・取得の規則を server と同じにする。fixtures の
  `templates/`（4 つ区切り）は local では値入りとして扱う今の動きを保つ。

### 文書

- 設計正典（ID の 2 形式・#46 の改訂）、要約、設計書、仕様一覧、操作手順書、`.claude/rules/editor.md` の雛形名。

## エラー処理

- 生成の 409 は 2 種類（作成済み・申請中）で文言を分ける。画面はトーストで出す。
- 規約外の形の ID は、どの入口でも 400 か 404（今と同じ）。

## テスト

- shared: 3 つ区切り・4 つ区切りの解析と組み立て、入口ごとの受ける形（片方だけ緩む穴が無いこと）、ペア ID と
  ペアのキーの両形式。
- server: 生成の ID が 3 つ区切りで基準日を生成器へ渡さないこと、409 の 2 種類、下書きと pending の破棄、
  取得の探し先、承認（origin=create）が `templates/<3 つ区切り>.html` に書くこと、テンプレート側のペア同期と
  状態ファイルの分離、偽の生成器のコピー元。
- web: 作成済みで「既存のテンプレートを開く」が出て、新規作成とシリーズから作成が押せないこと、基準日の項目を
  隠すこと、local の生成 ID。
- e2e: 作成タブで作ると `/edit/AM01_510037_交付版?created=1` が開くこと。
- 撮影と手引きの画像。

## 差分パッチ

- 作成済みの判定の修正までを含め、e82a5c2 → 実装後のコミットを 1 本にして GitHub Release に上げる。
- README の DB 作業（sproc 2 本）は前回と同じ。
