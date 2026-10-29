---
audience: spec
title: Editor 仕様一覧（画面項目 / 入出力 / DB / テスト）
version: "2.3"
rev:
  - 1.0 | 2026-08-02 | 初版
  - 1.1 | 2026-08-15 | 実装との突合（ロール approver・REST ルート全列挙・sproc 7 本・注記マスタ）
  - 1.2 | 2026-10-02 | 候補の出所（scope）と系列のファイル化、sproc `template` の `系列` 削除
  - 1.3 | 2026-10-03 | 作成タブの候補を Rep1 のファンド属性へ（companies / funds / creatable）、sproc `シリーズ` 追加、テンプレート台帳と `/templates/series` の削除
  - 1.4 | 2026-10-03 | テンプレートの ID から基準日を外す（作成タブの基準日の項目を削除、既存・作成中を開くボタン、creatable の templateId / inProgressId、generate の 409 の 3 種類と replaceExisting）
  - 1.5 | 2026-10-05 | Template の cssMissing、申請の fundCode の削除と cssBaseline の追加、同期状態の CSS の競合、build の singleDoc の扱い
  - 1.6 | 2026-10-08 | パーツカタログの対象版種と分類の英名、パーツ一覧と分類候補の版種による絞り込み（`@版種` と `editionType`）
  - 1.7 | 2026-10-23 | 生成 API を 1 回の作成で両版と組入先を取り込む形へ（GenerateRequest の rep1CompanyCode、GenerateResult の importedIds / skipped、409・400 の条件）
  - 1.8 | 2026-10-23 | 作成タブに基準日の任意入力（画面項目 9、GenerateRequest の baseDate）
  - 1.9 | 2026-10-26 | API 表にパーツ判定（part-decision）を追加して番号を振り直し、最終確定（approve）の編集経路の判定の当て方と 400・409 の条件を記載
  - 2.0 | 2026-10-28 | 作成タブの基準日の入力を撤去（画面項目 9 と GenerateRequest の baseDate。1.8 で追加したが、画面で選ばせる必要が無く、いつもサーバの既定値＝日本時間の当日・土日は直前の金曜で作るため。画面項目 10 以降を 1 つずつ繰り上げ）。版種を任意にし、選べばその版だけ、選ばなければ作成済み・申請中でない版をすべて作る形へ（繰り上げ後の画面項目 6・9・10、creatable の editionType を任意にして版ごとの状態 editions を返す、GenerateRequest の editionType を任意に、GenerateResult の template? / imported / skipped）。組入先を取り込まない（生成器の出力は output/ に残す）
  - 2.1 | 2026-10-29 | パーツ判定の API を `POST /review-requests/:reqId/part-decisions`（まとめて判定・取り消し、同じ partKey の重複は 400、却下の理由は UTF-16 で 2,000 単位まで、許されない遷移は 409 `REVIEW_PART_DECISION_TRANSITION` で全部戻す）へ改め、旧パス `/part-decision` を削除。決着済みの申請への判定・最終確定・却下の 409 `REVIEW_ALREADY_DECIDED`
  - 2.2 | 2026-10-29 | パーツ判定で申請の差分に無いパーツの承認・却下を 400 に（API 41）。申請ごと却下の理由に UTF-16 で 2,000 単位までの上限、入力の型名を ReviewRejectBody に訂正（API 43）
  - 2.3 | 2026-10-29 | パーツ判定の 400・409 の文言に並べるキーを先頭 20 件までに（API 41）
---

対象: 運報自動化 Editor（rest モード: REST + SQL Server）／ 版 2.3 ／ 出典: editor/ 実装コード・DDL・テスト

# 画面項目定義

| No | 画面 | 項目名 | 物理名/キー | 型 | 必須 | 入力規則・備考 |
|:--:|---|---|---|---|:--:|---|
| 1 | ログイン | ユーザーID | `username` | `string` | ○ | 半角英数字とアンダースコアのみ（USERNAME_PATTERN）。前後空白はトリム |
| 2 | ログイン | パスワード | `password` | `string` | ○ | マスク表示。初回ログインは要パスワード変更（mustChangePassword）でPW初期化画面へ |
| 3 | PW初期化 | 新パスワード | `password` | `string` | ○ | mustChangePassword=true のとき必須。/auth/init-password で確定 |
| 4 | テンプレート作成 | 委託会社 | `companyCode` | `string` | ○ | ドロップダウン（/templates/companies）。表示は「略称（委託会社コード）」、値はファイル名の会社コード（Rep1 の委託会社略称）。略称の前方一致か委託会社コードでも絞れる |
| 5 | テンプレート作成 | ファンド | `fundCode` | `string` | ○ | ドロップダウン（/templates/funds。会社を選ぶと Rep1 の委託会社コードで一括取得）。表示は「コード 名称」 |
| 6 | テンプレート作成 | 版種 | `editionType` | `string` |  | ドロップダウン「版種（任意）」（交付版 / 全体版 / 選ばない（両版を作る））。任意。選べばその版だけを作り、選ばなければ作成済み・申請中でない版をすべて作る。既定と、未選択に戻す選択肢の表示はどちらも「選ばない（両版を作る）」で、このとき要求に editionType を載せない。選んだときは Step 2 の説明に「<版>だけを作り、作成後はその編集画面が開きます。組入先は取り込みません。」と出す（組入先は版種の有無にかかわらず取り込まない）。選ばずに片方の版が作成済みか申請中なら、作成方法の上に 2 行の注記（例: 「全体版は作成済みです。交付版だけを作ります。」「あとで両版のパーツ同期を行うと、作成済みの全体版との差分が競合として出ることがあります。」。申請中なら「申請中です」「申請中の全体版との差分」）を出す。両版を作った後は編集画面へ移らず、Step 2 の下に成功の帯「交付版と全体版を作成しました。どちらを開くか選んでください。開かなかった版は、作成中のテンプレートから開けます。」と、テンプレート ID を添えた「交付版を開く」「全体版を開く」のカードを出す（押すと作成経路で開く。属性を変えると消える）。片方の版だけができたらその版の編集画面へ移り、飛ばした版を「全体版は作成済みのため飛ばしました」（申請中なら「申請中のため飛ばしました」）とトーストで知らせる。URL のクエリ `editionType` があれば復元する（古いブックマークの `?editionType=交付版` は、交付版だけを作る意味になる） |
| 7 | テンプレート作成 | コピー元ファンド | `sourceFundCode` | `string` |  | シリーズから作成するときに、同じシリーズの候補（/templates/creatable）から選ぶ。コピー元のテンプレートが無い候補は警告し作成不可 |
| 8 | テンプレート作成 | 償還 | `isRedemption` | `boolean` |  | 償還ファンドとして作成。生成器へ末尾の位置引数 `1` として渡す（コピー元が無いときは、コピー元の位置に空文字を入れる） |
| 9 | テンプレート作成 | 既存のテンプレートを開く | — | ボタン |  | 作成済みの版（/templates/creatable の editions の state=created）を開く。版種を選んだときは、その版が作成済みなら「既存のテンプレートを開く」を出す。版種を選ばず両版とも作れないときは、帯「交付版・全体版とも作成済みです。直すときは既存のテンプレートを開いてください。」「交付版・全体版とも承認待ちです。」「交付版は作成済みです。全体版は承認待ちです。」（版名は状況で入れ替える）のどれかを出し、作成済みの版ごとに「既存の交付版を開く」「既存の全体版を開く」を出す。templateId を作成経路（?created=1）の編集画面で開く。作る版が無いとき（選んだ版が作成済みか申請中、または未選択で両版とも）は「属性から新規作成」「既存のシリーズを元に作成」は押せない |
| 10 | テンプレート作成 | 作成中のテンプレートを開く | — | ボタン |  | 作る版が作業中（/templates/creatable の editions の state=inProgress）のときだけ表示。版種を選んだときは「作成中のテンプレートを開く」、選ばないときは作業中の版ごとに「作成中の交付版を開く」「作成中の全体版を開く」。templateId を作成経路で開く。新規作成・シリーズから作成は押せるが、「作業中の内容を捨てて作り直しますか」と確認し（本文は「<交付版 / 全体版 / 交付版・全体版の両方>について、作成中のテンプレートの下書きと生成した内容を捨てて、新しく作り直します。コメントと修正履歴は残ります。」）、同意したら replaceExisting=true で生成する。両版を作った後の「交付版を開く」「全体版を開く」のカードを出している間は表示しない |
| 11 | ユーザー管理 | ユーザーID | `username` | `string` | ○ | validateNewUser: 必須・パターン・重複（大小無視）チェック |
| 12 | ユーザー管理 | 表示名 | `displayName` | `string` | ○ | 未入力で『表示名を入力してください』 |
| 13 | ユーザー管理 | ロール | `role` | `admin \| approver \| editor \| viewer` | ○ | admin = 全権 / approver = 精査者（確定保存の承認・却下） / editor = 編集者（申請のみ） / viewer = 閲覧。admin のみユーザー管理可（isAdmin） |
| 14 | ユーザー管理 | 無効 | `disabled` | `boolean` |  | 無効化フラグ |
| 15 | 編集 | テンプレートID | `templateId` | `string` | ○ | 下書き保存（PUT /templates/:id/draft）対象 |
| 16 | 編集 | HTML | `html` | `string` | ○ | GrapesJS 本文。確定保存はファイル保存 |
| 17 | 編集 | CSS | `css` | `string` | ○ | 本文スタイル |
| 18 | 編集 | 変更箇所の赤入れ表示 | `showRedline` | `boolean` |  | 既定 OFF。ボタンで ON にしたときだけ、確定版と draft の差分を canvas の生 DOM に取り消し線で表示（保存・申請・PDF には載らない）。作成経路では非表示 |

# 入出力定義（REST API）

| No | Method | パス | 認証 | 入力 | 出力 |
|:--:|:--:|---|:--:|---|---|
| 1 | `GET` | `/health` |  | — | `{ok:true}`（死活監視） |
| 2 | `POST` | `/auth/login` |  | LoginRequest（username, password） | LoginResult（user, mustChangePassword） |
| 3 | `POST` | `/auth/init-password` | Cookie | PasswordInitRequest（username, currentPassword, newPassword） | 204 / 更新後 User（本人一致 + 現行パスワードの検証を通す） |
| 4 | `POST` | `/auth/logout` | Cookie | — | 204（セッション失効） |
| 5 | `GET` | `/auth/me` | Cookie | — | User（未認証は401） |
| 6 | `GET` | `/templates/options` | ○ | companyCode, fundCode, baseDate, editionType（任意）、scope（edit / published。省略時 edit） | DropdownOptions |
| 7 | `GET` | `/templates/companies` | ○ | — | CompanyOption[]（companyCode = 略称, companyName, rep1CompanyCode） |
| 8 | `GET` | `/templates/funds` | ○ | rep1CompanyCode（必須） | FundOption[]（fundCode, fundName） |
| 9 | `GET` | `/templates/creatable` | ○ | companyCode, rep1CompanyCode, fundCode（必須）, editionType（任意） | CreatableInfo（editions[editionType, state, templateId?]（editionType を指定すればその版の 1 件、無ければ交付版・全体版の順に 2 件。state は created / pendingReview / inProgress / none で、判定はこの順に優先する。作成済みの版の下書きは作業中に数えない。templateId は created なら templates/ のファイルの綴り、inProgress なら pending を優先し無ければ下書きの綴り。none と pendingReview では持たない）, seriesFunds[fundCode, fundName, hasTemplate（コピー元の両版がそろっているか）]） |
| 10 | `GET` | `/templates` | ○ | 属性フィルタ（DropdownQuery） | TemplateMeta[] |
| 11 | `GET` | `/templates/:id` | ○ | id | Template（meta + html + css + cssMissing?（CSS ファイルが無いとき true）） |
| 12 | `GET` | `/templates/:id/draft` | ○ | id | TemplateDraft |
| 13 | `PUT` | `/templates/:id/draft` | editor | SaveDraftRequest（templateId, html, css） | 204 |
| 14 | `DELETE` | `/templates/:id/draft` | editor | id | 204（下書き破棄） |
| 15 | `GET` | `/templates/:id/sync-status` | ○ | id | 交付版⇄全体版パーツ同期の状態（パーツの競合と、テンプレの CSS の競合 cssConflicts、ペアから写した Jinja パーツのうちこの版で値を確かめてほしいもの valueChecks） |
| 16 | `GET` | `/templates/:id/sample-data` | ○ | id（3 区切り・4 区切り） | SampleDataResult（共通サンプル + Rep1 の実名、合成の warnings） |
| 17 | `GET` | `/templates/:id/values` | ○ | id（4 区切り。編集タブのテンプレート） | TemplateValues（found = `<dataRoot>/json/<ID>.json` があったか、values = その中身。無ければ found: false と空。挿入する Jinja パーツの描画に使う） |
| 18 | `POST` | `/generate` | editor | GenerateRequest（companyCode, rep1CompanyCode, fundCode, editionType?, sourceFundCode?, isRedemption?, replaceExisting?）。editionType（交付版・全体版のどちらか）を指定すればその版だけを作り、省略すれば作成済み・申請中でない版をすべて作る。editionType が空文字かそれ以外の値なら 400。生成される id は `会社_ファンド_版種`（基準日なし）。companyCode と rep1CompanyCode が Rep1 で同じ会社の組でなければ 400。生成器へは基準日を editor が渡す（日本時間の当日。土日は直前の金曜）。古い画面が送る baseDate は 400 にせず無視する。editionType があるとき、その版が作成済みなら 409「作成済みです。既存のテンプレートを開いてください」、承認待ちの作成申請があれば 409「申請中です。承認か却下を待ってください」（もう片方の版の有無は問わない）。editionType が無いときは、作成済み・申請中の版を飛ばして skipped に載せ、残りの版を作る。両版とも作成済みか申請中なら、作成済みが 1 つでもあれば前者、無ければ後者の 409。作る版に下書きか pending があり replaceExisting が無ければ 409「作成中のテンプレートがあります」（replaceExisting があれば作る版の作業中だけを置き換え、作らない版の下書き・pending には触らない）。生成器は常に両版と組入先を書くが、取り込むのは作る版だけ。組入先は取り込まず output/ に残す。editionType を指定したときのもう片方の版の出力は output/ から消し、editionType を省略して飛ばした版の出力は残す。生成器が失敗した・出力の検査に外れた（会社違い・作る版の欠け・本数超過など）ときは何も取り込まない。同じ会社の作成は 1 本ずつ実行する。下書きと pending は生成の成功後に捨てる。sourceFundCode のコピー元テンプレートは、片方の版だけを作るときも両版がそろっていなければ 400 | GenerateResult（template? = 取り込んだ版がちょうど 1 つのときだけ、その版のテンプレート骨子 + draft、imported = 取り込んだ版 [templateId, editionType]（交付版・全体版の順）、skipped = editionType を省略して飛ばした版 [templateId, editionType, reason（created / pendingReview）]） |
| 19 | `GET` | `/parts` | ○ | 分類フィルタ、editionType（任意。編集中テンプレートの版種）、companyCode（任意。編集中テンプレートの Rep1 の委託会社コード。指定時は一致するパーツだけ） | PartCatalogItem[]（対象版種 `targetEdition`・委託会社コード `companyCode` を含む） |
| 20 | `GET` | `/parts/classification-options` | ○ | editionType・companyCode（任意。分類ドロップダウン候補の絞り込み。扱いは `/parts` と同じ） | 分類ドロップダウン候補 |
| 21 | `GET` | `/templates/:templateId/part-history` | ○ | templateId | パーツ変更履歴 |
| 22 | `POST` | `/templates/:templateId/part-history` | editor | RecordPartChangeRequest | 204（パーツ変更の記録） |
| 23 | `GET` | `/templates/:templateId/notes` | ○ | templateId | パーツ単位メモ一覧 |
| 24 | `PUT` | `/templates/:templateId/notes` | editor | SaveNoteRequest（pathKey, content。空文字＝削除） | 204 |
| 25 | `POST` | `/build` | ○ | BuildInlineRequest（html, css, size, singleDoc（受け付けるが無視する）） | PDF（vivliostyle） |
| 26 | `POST` | `/build/project` | editor | プロジェクト zip | PDF |
| 27 | `POST` | `/build/merge` | ○ | BuildMergeRequest（documents = html/css の配列, size?） | PDF（複数文書を結合・通しページ番号） |
| 28 | `GET` | `/preview` | ○ | — | 稼働中プレビューセッション一覧（自分の分のみ） |
| 29 | `POST` | `/preview` | editor | inline JSON（html, css）またはプロジェクト zip | プレビューセッション開始 |
| 30 | `GET` | `/preview/:id`（`/*` 配下を含む） | ○ | id | プレビュー（reverse proxy） |
| 31 | `DELETE` | `/preview/:id` | editor | id | 204（セッション終了） |
| 32 | `GET` | `/history/edit` | ○ | — | 編集履歴一覧 |
| 33 | `GET` | `/history/pdf` | ○ | — | PDF出力履歴一覧 |
| 34 | `POST` | `/history/pdf` | ○ | RecordPdfExportRequest | 204（PDF 出力の記録） |
| 35 | `GET` | `/history/create` | ○ | — | 作成履歴一覧 |
| 36 | `GET` | `/templates/:templateId/versions` | ○ | templateId | 版一覧（比較用）。テンプレート（3 つ区切り）は空の配列 |
| 37 | `GET` | `/snapshots/:historyId` | ○ | historyId | スナップショット本文 |
| 38 | `POST` | `/review-requests` | editor | SubmitReviewBody（templateId, html, css, filledHtml?, cssBaseline?（確定版の CSS を編集画面の書き出しの形にしたもの。無ければ CSS のペア転写を飛ばす）, origin） | ReviewRequestMeta（pending。実ファイル非更新） |
| 39 | `GET` | `/review-requests` | ○ | status（任意） | ReviewRequestMeta[]（精査者・admin は全件、editor は自分の申請のみ） |
| 40 | `GET` | `/review-requests/:reqId` | ○ | reqId | ReviewRequest（本体込み） |
| 41 | `POST` | `/review-requests/:reqId/part-decisions` | approver | UpdateReviewPartDecisionsRequest（decisions = ReviewPartDecisionChange の配列、1〜5,000 件。各要素は partKey = 文書全体での `<アンカー>#<通し番号>` と status。status = approved（理由は送らない）／ rejected（comment = 却下の理由。必須、前後の空白を除いて 1 文字以上、UTF-16 で 2,000 単位まで）／ pending（判定の取り消し）。1 回の要求に同じ partKey を 2 回入れると 400（スキーマの追加検査なので OpenAPI の定義には出ない）。申請の差分（編集経路は申請時点の比較元と申請の本文の差分の変更パーツ、作成経路は Jinja 原文のパーツ）に無い partKey の承認・却下も 400 で、何も保存しない。400・409 の文言に並べるキーは先頭 20 件までで、残りは件数だけ。1 件の判定もこの API で送る） | ReviewPartDecision[]（更新後の判定を入力の順に。各要素は現在の判定・判定者・日時・却下の理由と変更履歴 history。取り消したパーツは status = pending で返る）。承認待ちの申請だけで、自分の申請は admin を除き判定できない（403）。許す遷移は「未判定 → 承認・却下」と「承認・却下 → 未判定」だけで、それ以外（承認と却下の直接の付け替え・未判定の取り消し・同じ判定の再送）が 1 件でもあれば 409 `REVIEW_PART_DECISION_TRANSITION` で何も保存しない。決着済み（承認済み・却下済み）の申請は 409 `REVIEW_ALREADY_DECIDED` |
| 42 | `POST` | `/review-requests/:reqId/approve` | approver | ReviewDecisionRequest（comment。承認タブは送らない） | ApproveReviewResult（実ファイル反映 + git コミット。自己承認は拒否）。決着済みの申請は 409 `REVIEW_ALREADY_DECIDED`。作成経路は却下したパーツを Jinja 原文から除いて書く。編集経路は承認画面と同じ差分でパーツ判定を検査し（未判定・本文に無い判定・判定の重複・差分の打ち切りは 400）、却下したパーツだけを申請時点の現行版へ戻して書く。却下があり申請後に現行版の HTML が変わっていれば 409 `REVIEW_BASE_CHANGED`、戻す位置を確かめられなければ 409 `REVIEW_SPLICE_MISMATCH`、比較元の無い古い申請に判定があれば 409 `REVIEW_BASE_MISSING` |
| 43 | `POST` | `/review-requests/:reqId/reject` | approver | ReviewRejectBody（comment 必須。前後の空白を除いて 1 文字以上、UTF-16 で 2,000 単位まで。上限は空白を除く前の長さで数える） | ReviewRequestMeta（rejected）。決着済みの申請は 409 `REVIEW_ALREADY_DECIDED` |
| 44 | `GET` | `/users` | admin | — | User[] |
| 45 | `POST` | `/users` | admin | CreateUserRequest（username, displayName, role, disabled, mustChangePassword） | 作成結果（一時パスワードは応答 1 回のみ） |
| 46 | `PATCH` | `/users/:id` | admin | UpdateUserRequest（username, displayName, role, disabled, mustChangePassword） | 更新後 User |
| 47 | `POST` | `/users/:id/reset-password` | admin | id | PWリセット結果（一時パスワード。要PW変更） |

認証欄の凡例: 空欄 = 認証不要 ／ Cookie = ログイン済みセッション ／ ○ = ログイン済みなら全ロール ／ editor・approver・admin = そのロール以上（admin は全権）。パスは `/api` プレフィックスを省いて示す。ルートと必要ロールの正典は `server/src/routes/routeGuards.ts` の `ROUTE_POLICY`。

# DB定義（テーブル）

| テーブル | カラム | 型 | PK | NULL可 | 既定 | 説明 |
|---|---|---|:--:|:--:|---|---|
| ユーザー | ユーザーID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_ユーザー |
| ユーザー | 公開ID | `NVARCHAR(64)` |  |  |  | API 公開する id |
| ユーザー | ログインID | `NVARCHAR(64)` |  |  |  |  |
| ユーザー | 表示名 | `NVARCHAR(128)` |  |  |  |  |
| ユーザー | ロール | `NVARCHAR(16)` |  |  |  | admin / approver / editor / viewer |
| ユーザー | 無効 | `BIT` |  |  | `0` |  |
| ユーザー | 要パスワード変更 | `BIT` |  |  | `1` | 初回ログインで初期化 |
| ユーザー | PWハッシュ | `VARBINARY(64)` |  | ○ |  | PBKDF2 派生鍵。APIに出さない |
| ユーザー | PWソルト | `VARBINARY(32)` |  | ○ |  |  |
| ユーザー | PW反復回数 | `INT` |  | ○ |  | PBKDF2 iterations |
| ユーザー | 作成日時 | `DATETIME2(3)` |  |  | `SYSUTCDATETIME()` |  |
| ユーザー | 更新日時 | `DATETIME2(3)` |  | ○ |  |  |
| パーツカタログ | パーツ内部ID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_パーツカタログ |
| パーツカタログ | パーツID | `NVARCHAR(64)` |  |  |  | data-part-id にも使用 |
| パーツカタログ | カテゴリ | `NVARCHAR(64)` |  |  |  |  |
| パーツカタログ | 大分類 | `NVARCHAR(64)` |  |  |  |  |
| パーツカタログ | 中分類 | `NVARCHAR(64)` |  |  |  |  |
| パーツカタログ | 小分類 | `NVARCHAR(64)` |  |  |  |  |
| パーツカタログ | 名称 | `NVARCHAR(128)` |  |  |  |  |
| パーツカタログ | 説明 | `NVARCHAR(512)` |  | ○ |  |  |
| パーツカタログ | 使用上の注意 | `NVARCHAR(512)` |  | ○ |  |  |
| パーツカタログ | 内容HTML | `NVARCHAR(MAX)` |  |  |  | カタログ素材はDB保持 |
| パーツカタログ | 更新日時 | `DATETIME2(3)` |  | ○ |  |  |
| パーツカタログ | 更新者 | `NVARCHAR(64)` |  | ○ |  |  |
| パーツカタログ | 同期既定 | `NVARCHAR(16)` |  | ○ |  | 交付版⇄全体版パーツ同期のポリシー（同期 / 非同期 / 交付版のみ / 全体版のみ / NULL=未判断） |
| パーツカタログ | 次回反映既定 | `NVARCHAR(16)` |  | ○ |  | 承認確定パーツの注記マスタ書き戻し（反映 / 非反映 / NULL=未判断=反映しない） |
| パーツカタログ | 対象版種 | `NVARCHAR(32)` |  | ○ |  | 一覧に出す版種（NULL=両版共通）。値はテンプレートの版種と同じ文字列で、固定しない。表示の絞り込みだけに使い、ペア同期のポリシーは同期既定だけで決める |
| パーツカタログ | カテゴリ英名 | `NVARCHAR(128)` |  | ○ |  | 別ツール用。editor は読まない |
| パーツカタログ | 大分類英名 | `NVARCHAR(128)` |  | ○ |  | 同上 |
| パーツカタログ | 中分類英名 | `NVARCHAR(128)` |  | ○ |  | 同上 |
| パーツカタログ | 小分類英名 | `NVARCHAR(128)` |  | ○ |  | 同上 |
| パーツカタログ | 委託会社コード | `CHAR(5)` |  | ○ |  | パーツ一覧を編集中のテンプレートの委託会社（Rep1 の委託会社コード）で絞る。NULL は未設定で、どの会社の一覧にも出ない |
| 監査ログ | 監査ID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_監査ログ |
| 監査ログ | イベント | `NVARCHAR(64)` |  |  |  |  |
| 監査ログ | 結果 | `NVARCHAR(8)` |  |  |  | success / failure |
| 監査ログ | 実行者 | `NVARCHAR(64)` |  |  |  |  |
| 監査ログ | IP | `NVARCHAR(64)` |  | ○ |  |  |
| 監査ログ | リソースJSON | `NVARCHAR(MAX)` |  | ○ |  | テキスト保管 |
| 監査ログ | 詳細JSON | `NVARCHAR(MAX)` |  | ○ |  |  |
| 監査ログ | エラー | `NVARCHAR(MAX)` |  | ○ |  |  |
| 監査ログ | 発生日時 | `DATETIME2(3)` |  |  | `SYSUTCDATETIME()` |  |
| 共通サンプル | 共通サンプルID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_共通サンプル。作成タブ系の表示値。合成は ID 昇順 |
| 共通サンプル | カテゴリ | `NVARCHAR(64)` |  | ○ |  | パーツカタログの同名列と同じ文字列。下位を空にすると上位の分類全体の行、4 段とも空は全体共通の行 |
| 共通サンプル | 大分類 | `NVARCHAR(64)` |  | ○ |  | 同上 |
| 共通サンプル | 中分類 | `NVARCHAR(64)` |  | ○ |  | 同上 |
| 共通サンプル | 小分類 | `NVARCHAR(64)` |  | ○ |  | 同上 |
| 共通サンプル | データJSON | `NVARCHAR(MAX)` |  |  |  | トップレベルが object の JSON 断片。キーは行をまたいで重ねない（重なれば ID の小さい行を採る） |
| 共通サンプル | 更新日時 | `DATETIME2(3)` |  | ○ |  |  |
| 共通サンプル | 更新者 | `NVARCHAR(64)` |  | ○ |  |  |
| 共通サンプル | 分類キー | 計算列（PERSISTED） |  |  |  | 分類 4 段を空文字列へ寄せてつないだもの。一意索引で分類の組を一意にする（書き込みには `QUOTED_IDENTIFIER ON` が要る） |
| セッション | セッションID | `NVARCHAR(64)` | ○ |  |  | cookie editor.sid |
| セッション | ログインID | `NVARCHAR(64)` |  |  |  |  |
| セッション | 作成日時 | `DATETIME2(3)` |  |  | `SYSUTCDATETIME()` |  |
| セッション | 最終アクセス | `DATETIME2(3)` |  |  | `SYSUTCDATETIME()` |  |
| セッション | 有効期限 | `DATETIME2(3)` |  |  |  |  |
| セッション | 失効 | `BIT` |  |  | `0` |  |
| 注記マスタ | 注記内部ID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_注記マスタ（仮組。実運用の既存注記テーブルへ差し替え前提） |
| 注記マスタ | パーツID | `NVARCHAR(64)` |  |  |  | キーは（パーツID, ファンドコード, 版種） |
| 注記マスタ | ファンドコード | `NVARCHAR(32)` |  |  |  |  |
| 注記マスタ | 版種 | `NVARCHAR(16)` |  |  |  |  |
| 注記マスタ | 注記HTML | `NVARCHAR(MAX)` |  | ○ |  | 承認確定パーツの HTML |
| 注記マスタ | 更新日時 | `DATETIME2(3)` |  | ○ |  |  |
| 注記マスタ | 更新者 | `NVARCHAR(64)` |  | ○ |  |  |

# DBストアド（sproc）

| No | ゲートウェイ | @操作 | 用途 |
|:--:|---|---|---|
| 1 | `template` | 委託会社一覧 | 作成タブの委託会社候補と、全画面の委託会社表示「略称（委託会社コード）」（Rep1。委託会社コード・委託会社名・委託会社略称） |
| 2 | `template` | ファンド一覧 | 作成タブのファンド候補と、全画面のファンド名表示（Rep1。委託会社コードで一括取得） |
| 3 | `series` | 一覧 | 委託会社のファンドとシリーズコード（Rep1。シリーズから作成のコピー元候補の素） |
| 4 | `user` | 一覧 | ユーザー一覧 |
| 5 | `user` | 作成 | ユーザー作成 |
| 6 | `user` | 更新 | 表示名/ロール/無効 更新 |
| 7 | `user` | PWリセット | 管理者によるPWリセット（要PW変更） |
| 8 | `user` | 認証情報取得 | ログイン認証用のハッシュ取得 |
| 9 | `user` | PW初期化 | 初回PW設定（旧セッションの失効と同一トランザクション） |
| 10 | `part` | 分類候補 | 分類ドロップダウン候補（カテゴリ/大/中/小）。`@版種` を渡すと、その版種のパーツと両版共通のパーツ（対象版種が NULL）の分類だけを返す。空なら全件。`@委託会社コード` を渡すと、`RTRIM` した委託会社コードが一致するパーツの分類だけを返す |
| 11 | `part` | 一覧 | 分類フィルタでパーツカタログ一覧（`対象版種`・`委託会社コード` を含む）。`@版種` と `@委託会社コード` の扱いは分類候補と同じ |
| 12 | `sample` | 共通一覧 | 共通サンプルの全行を ID 昇順で返す（引数なし。合成は server） |
| 13 | `session` | 作成 | セッション発行 |
| 14 | `session` | 取得 | セッション検証（期限/失効）＋ユーザー結合 |
| 15 | `session` | 失効 | ログアウトで失効 |
| 16 | `session` | 全失効 | サーバ起動時に全セッションを失効 |
| 17 | `session` | 掃除 | 期限切れセッションの削除 |
| 18 | `audit` | 登録 | 監査イベント記録（logger.ts 連携） |
| 19 | `noteMaster` | 反映 | 承認確定パーツの注記 HTML を（パーツID, ファンドコード, 版種）で upsert |
| 20 | `noteMaster` | 取得 | テンプレート生成直後に適用する注記マスタ行の取得 |

sproc ファイルは `server/db/sproc/` の 8 本（`audit` / `noteMaster` / `part` / `sample` / `series` / `session` / `template` / `user`）。`template` と `series` は同じサーバの `Rep1` を 3 部名で読む（テーブル名・列名は仮で、sproc の中だけに書く）。物理名は `server/src/db/sprocNames.ts` の `SP` に集約する。

# テスト仕様

| No | 区分 | テスト観点 | 手順 | 期待結果 | 結果 | 確認者 |
|:--:|---|---|---|---|:--:|---|
| 1 | 認証（E2E） | 未認証アクセス | 保護ページへ直接アクセス | ログイン画面へリダイレクト | 済 |  |
| 2 | 認証（E2E） | ログイン成功 | 正しいID/PWでログイン | 編集（/edit）タブへ遷移 | 済 |  |
| 3 | 認証（E2E） | ログイン失敗 | 不正なパスワードで送信 | エラー表示・ログイン画面に滞在 | 済 |  |
| 4 | API | OpenAPI パス網羅 | openapi.test.ts を実行 | apiPaths 正典の全パスとスキーマが定義済み | 済 |  |
| 5 | API | 公開エンドポイント | /health /auth/login の security | security:[]（認証不要） | 済 |  |
| 6 | 認可 | 管理者限定 | viewer で /users を呼ぶ | 403（requireAdmin） | 済 |  |
| 7 | ドメイン | ユーザー検証 | username に記号を含めて検証 | 『半角英数字とアンダースコアのみ』 | 済 |  |
| 8 | ドメイン | 重複ID | 既存ID（大小違い）で作成 | 『既に使われています』 | 済 |  |
| 9 | 入力検証 | zip アップロード | projectInput.test.ts | 不正zipを拒否 | 済 |  |
| 10 | 生成 | テンプレート生成 | pyTemplate.test.ts | 骨子HTMLを生成 | 済 |  |
| 11 | DB | DDL/索引/制約の適用 | apply.ps1 を 2 回実行（冪等性確認） | エラー無し・テーブル 7 / 索引 / CHECK 制約が仕様どおり | 済 |  |
| 12 | DB | sproc ゲートウェイ疎通 | 8 sproc の代表 @操作 を EXEC | 結果セット返却・THROW 50404/50409/50000 が仕様どおり | 済 |  |
| 13 | DB | REST 縦貫 + 監査ミラー | rest モードで login〜API〜logout | セッション作成/失効・監査ログが DB に記録 | 済 |  |
| 14 | 編集（E2E） | 赤入れ表示 | 文言を置換 → トグル OFF/ON → パーツ選択 → autosave | 旧文言が `del[data-redline]` で出る／OFF で消える／選択パーツの装飾が外れる／draft に `data-redline` が無い | 済 |  |

> 検証環境（2026-08-02）: SQL Server 2022 Express LocalDB + ODBC Driver 17 + msnodesqlv8 4.5.0
> （Node 24 prebuild）。2026-10-25 に msnodesqlv8 6.0.0（N-API の prebuild）で同じ LocalDB へ
> 接続・THROW の分類・並行上限・取り消しを再確認した。本番ターゲット SQL Server 2012 上での再検証は未実施
> （2012 非互換構文の不使用は静的確認済み）。
