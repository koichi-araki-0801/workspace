---
audience: spec
title: Editor 仕様一覧（画面項目 / 入出力 / DB / テスト）
version: "1.1"
rev:
  - 1.0 | 2026-08-02 | 初版
  - 1.1 | 2026-08-15 | 実装との突合（ロール approver・REST ルート全列挙・sproc 7 本・注記マスタ）
---

対象: 運報自動化 Editor（フェーズ2 REST + SQL Server）／ 版 1.1 ／ 出典: editor/ 実装コード・DDL・テスト

# 画面項目定義

| No | 画面 | 項目名 | 物理名/キー | 型 | 必須 | 入力規則・備考 |
|:--:|---|---|---|---|:--:|---|
| 1 | ログイン | ユーザーID | `username` | `string` | ○ | 半角英数字とアンダースコアのみ（USERNAME_PATTERN）。前後空白はトリム |
| 2 | ログイン | パスワード | `password` | `string` | ○ | マスク表示。初回ログインは要パスワード変更（mustChangePassword）でPW初期化画面へ |
| 3 | PW初期化 | 新パスワード | `password` | `string` | ○ | mustChangePassword=true のとき必須。/auth/init-password で確定 |
| 4 | テンプレート作成 | 委託会社コード | `companyCode` | `string` | ○ | ドロップダウン（/templates/options） |
| 5 | テンプレート作成 | ファンドコード | `fundCode` | `string` | ○ | ドロップダウン。シリーズは /templates/series |
| 6 | テンプレート作成 | 基準日 | `baseDate` | `string(yyyymmdd)` | ○ | 8桁。TemplateAttributes.baseDate |
| 7 | テンプレート作成 | 版種 | `editionType` | `string` | ○ | ドロップダウン（交付/運用 等） |
| 8 | テンプレート作成 | 派生元テンプレート | `basedOnTemplateId` | `string` |  | シリーズファンドから作成する場合に指定（任意） |
| 9 | ユーザー管理 | ユーザーID | `username` | `string` | ○ | validateNewUser: 必須・パターン・重複（大小無視）チェック |
| 10 | ユーザー管理 | 表示名 | `displayName` | `string` | ○ | 未入力で『表示名を入力してください』 |
| 11 | ユーザー管理 | ロール | `role` | `admin \| approver \| editor \| viewer` | ○ | admin = 全権 / approver = 精査者（確定保存の承認・却下） / editor = 編集者（申請のみ） / viewer = 閲覧。admin のみユーザー管理可（isAdmin） |
| 12 | ユーザー管理 | 無効 | `disabled` | `boolean` |  | 無効化フラグ |
| 13 | 編集 | テンプレートID | `templateId` | `string` | ○ | 下書き保存（PUT /templates/:id/draft）対象 |
| 14 | 編集 | HTML | `html` | `string` | ○ | GrapesJS 本文。確定保存はファイル保存 |
| 15 | 編集 | CSS | `css` | `string` | ○ | 本文スタイル |
| 16 | 編集 | 変更箇所の赤入れ表示 | `showRedline` | `boolean` |  | 既定 ON。確定版と draft の差分を canvas の生 DOM に取り消し線で表示（保存・申請・PDF には載らない）。作成経路では非表示 |

# 入出力定義（REST API）

| No | Method | パス | 認証 | 入力 | 出力 |
|:--:|:--:|---|:--:|---|---|
| 1 | `GET` | `/health` |  | — | `{ok:true}`（死活監視） |
| 2 | `POST` | `/auth/login` |  | LoginRequest（username, password） | LoginResult（user, mustChangePassword） |
| 3 | `POST` | `/auth/init-password` | Cookie | PasswordInitRequest（username, currentPassword, newPassword） | 204 / 更新後 User（本人一致 + 現行パスワードの検証を通す） |
| 4 | `POST` | `/auth/logout` | Cookie | — | 204（セッション失効） |
| 5 | `GET` | `/auth/me` | Cookie | — | User（未認証は401） |
| 6 | `GET` | `/templates/options` | ○ | companyCode, fundCode, baseDate, editionType（任意） | DropdownOptions |
| 7 | `GET` | `/templates/series` | ○ | companyCode, editionType（必須） | シリーズファンド一覧 |
| 8 | `GET` | `/templates` | ○ | 属性フィルタ（DropdownQuery） | TemplateMeta[] |
| 9 | `GET` | `/templates/:id` | ○ | id | Template（meta + html + css） |
| 10 | `GET` | `/templates/:id/draft` | ○ | id | TemplateDraft |
| 11 | `PUT` | `/templates/:id/draft` | editor | SaveDraftRequest（templateId, html, css） | 204 |
| 12 | `DELETE` | `/templates/:id/draft` | editor | id | 204（下書き破棄） |
| 13 | `GET` | `/templates/:id/sync-status` | ○ | id | 交付版⇄全体版パーツ同期の状態 |
| 14 | `GET` | `/funds/:fundCode/sample-data` | ○ | fundCode | SampleData（プレビュー context） |
| 15 | `POST` | `/generate` | editor | GenerateRequest（companyCode, fundCode, editionType, basedOnTemplateId?, isRedemption?） | GenerateResult（テンプレート骨子 + draft） |
| 16 | `GET` | `/parts` | ○ | 分類フィルタ | PartCatalogItem[] |
| 17 | `GET` | `/parts/classification-options` | ○ | — | 分類ドロップダウン候補 |
| 18 | `GET` | `/templates/:templateId/part-history` | ○ | templateId | パーツ変更履歴 |
| 19 | `POST` | `/templates/:templateId/part-history` | editor | RecordPartChangeRequest | 204（パーツ変更の記録） |
| 20 | `GET` | `/templates/:templateId/notes` | ○ | templateId | パーツ単位メモ一覧 |
| 21 | `PUT` | `/templates/:templateId/notes` | editor | SaveNoteRequest（pathKey, content。空文字＝削除） | 204 |
| 22 | `POST` | `/build` | ○ | BuildInlineRequest（html, css, size, singleDoc） | PDF（vivliostyle） |
| 23 | `POST` | `/build/project` | editor | プロジェクト zip | PDF |
| 24 | `POST` | `/build/merge` | ○ | BuildMergeRequest（documents = html/css の配列, size?） | PDF（複数文書を結合・通しページ番号） |
| 25 | `GET` | `/preview` | ○ | — | 稼働中プレビューセッション一覧（自分の分のみ） |
| 26 | `POST` | `/preview` | editor | inline JSON（html, css）またはプロジェクト zip | プレビューセッション開始 |
| 27 | `GET` | `/preview/:id`（`/*` 配下を含む） | ○ | id | プレビュー（reverse proxy） |
| 28 | `DELETE` | `/preview/:id` | editor | id | 204（セッション終了） |
| 29 | `GET` | `/history/edit` | ○ | — | 編集履歴一覧 |
| 30 | `GET` | `/history/pdf` | ○ | — | PDF出力履歴一覧 |
| 31 | `POST` | `/history/pdf` | ○ | RecordPdfExportRequest | 204（PDF 出力の記録） |
| 32 | `GET` | `/history/create` | ○ | — | 作成履歴一覧 |
| 33 | `GET` | `/templates/:templateId/versions` | ○ | templateId | 版一覧（比較用） |
| 34 | `GET` | `/snapshots/:historyId` | ○ | historyId | スナップショット本文 |
| 35 | `POST` | `/review-requests` | editor | SubmitReviewBody（templateId, html, css, fundCode, filledHtml?, origin） | ReviewRequestMeta（pending。実ファイル非更新） |
| 36 | `GET` | `/review-requests` | ○ | status（任意） | ReviewRequestMeta[]（精査者・admin は全件、editor は自分の申請のみ） |
| 37 | `GET` | `/review-requests/:reqId` | ○ | reqId | ReviewRequest（本体込み） |
| 38 | `POST` | `/review-requests/:reqId/approve` | approver | ReviewDecisionRequest（comment） | ApproveReviewResult（実ファイル反映 + git コミット。自己承認は拒否） |
| 39 | `POST` | `/review-requests/:reqId/reject` | approver | ReviewDecisionRequest（comment 必須） | ReviewRequestMeta（rejected） |
| 40 | `GET` | `/users` | admin | — | User[] |
| 41 | `POST` | `/users` | admin | CreateUserRequest（username, displayName, role, disabled, mustChangePassword） | 作成結果（一時パスワードは応答 1 回のみ） |
| 42 | `PATCH` | `/users/:id` | admin | UpdateUserRequest（username, displayName, role, disabled, mustChangePassword） | 更新後 User |
| 43 | `POST` | `/users/:id/reset-password` | admin | id | PWリセット結果（一時パスワード。要PW変更） |

認証欄の凡例: 空欄 = 認証不要 ／ Cookie = ログイン済みセッション ／ ○ = ログイン済みなら全ロール ／ editor・approver・admin = そのロール以上（admin は全権）。パスは `/api` プレフィックスを省いて示す。ルートと必要ロールの正典は `server/src/routes/routeGuards.ts` の `ROUTE_POLICY`。

# DB定義（テーブル）

| テーブル | カラム | 型 | PK | NULL可 | 既定 | 説明 |
|---|---|---|:--:|:--:|---|---|
| テンプレート台帳 | 台帳ID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_テンプレート台帳。1テンプレート=1行 |
| テンプレート台帳 | テンプレートID | `NVARCHAR(128)` |  |  |  | Japanese_CI_AS |
| テンプレート台帳 | 委託会社コード | `NVARCHAR(32)` |  |  |  |  |
| テンプレート台帳 | ファンドコード | `NVARCHAR(32)` |  |  |  |  |
| テンプレート台帳 | 基準日 | `NVARCHAR(8)` |  |  |  | yyyymmdd |
| テンプレート台帳 | 版種 | `NVARCHAR(16)` |  |  |  |  |
| テンプレート台帳 | ファイル名 | `NVARCHAR(160)` |  |  |  |  |
| テンプレート台帳 | 状態 | `NVARCHAR(16)` |  |  | `N'draft'` | draft / published |
| テンプレート台帳 | 更新日時 | `DATETIME2(3)` |  | ○ |  | UTC |
| テンプレート台帳 | 更新者 | `NVARCHAR(64)` |  | ○ |  |  |
| テンプレート台帳 | 作成日時 | `DATETIME2(3)` |  |  | `SYSUTCDATETIME()` | UTC |
| テンプレート台帳 | 論理削除 | `BIT` |  |  | `0` |  |
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
| 監査ログ | 監査ID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_監査ログ |
| 監査ログ | イベント | `NVARCHAR(64)` |  |  |  |  |
| 監査ログ | 結果 | `NVARCHAR(8)` |  |  |  | success / failure |
| 監査ログ | 実行者 | `NVARCHAR(64)` |  |  |  |  |
| 監査ログ | IP | `NVARCHAR(64)` |  | ○ |  |  |
| 監査ログ | リソースJSON | `NVARCHAR(MAX)` |  | ○ |  | テキスト保管 |
| 監査ログ | 詳細JSON | `NVARCHAR(MAX)` |  | ○ |  |  |
| 監査ログ | エラー | `NVARCHAR(MAX)` |  | ○ |  |  |
| 監査ログ | 発生日時 | `DATETIME2(3)` |  |  | `SYSUTCDATETIME()` |  |
| サンプルデータ | サンプルID | `BIGINT IDENTITY` | ○ |  |  | Rep1_運報自動化_Editor_サンプルデータ |
| サンプルデータ | ファンドコード | `NVARCHAR(32)` |  |  |  |  |
| サンプルデータ | データJSON | `NVARCHAR(MAX)` |  |  |  | プレビュー context |
| サンプルデータ | 更新日時 | `DATETIME2(3)` |  | ○ |  |  |
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
| 1 | `template` | 候補 | 属性ドロップダウン候補（/templates/options） |
| 2 | `template` | 系列 | シリーズファンド一覧 |
| 3 | `template` | 生成登録 | 生成直後に台帳行を draft 作成（冪等） |
| 4 | `user` | 一覧 | ユーザー一覧 |
| 5 | `user` | 作成 | ユーザー作成 |
| 6 | `user` | 更新 | 表示名/ロール/無効 更新 |
| 7 | `user` | PWリセット | 管理者によるPWリセット（要PW変更） |
| 8 | `user` | 認証情報取得 | ログイン認証用のハッシュ取得 |
| 9 | `user` | PW初期化 | 初回PW設定（旧セッションの失効と同一トランザクション） |
| 10 | `part` | 分類候補 | 分類ドロップダウン候補（カテゴリ/大/中/小） |
| 11 | `part` | 一覧 | 分類フィルタでパーツカタログ一覧 |
| 12 | `sample` | 取得 | ファンド別サンプルデータ取得 |
| 13 | `session` | 作成 | セッション発行 |
| 14 | `session` | 取得 | セッション検証（期限/失効）＋ユーザー結合 |
| 15 | `session` | 失効 | ログアウトで失効 |
| 16 | `session` | 全失効 | サーバ起動時に全セッションを失効 |
| 17 | `session` | 掃除 | 期限切れセッションの削除 |
| 18 | `audit` | 登録 | 監査イベント記録（logger.ts 連携） |
| 19 | `noteMaster` | 反映 | 承認確定パーツの注記 HTML を（パーツID, ファンドコード, 版種）で upsert |
| 20 | `noteMaster` | 取得 | テンプレート生成直後に適用する注記マスタ行の取得 |

sproc ファイルは `server/db/sproc/` の 7 本（`audit` / `noteMaster` / `part` / `sample` / `session` / `template` / `user`）。物理名は `server/src/db/sprocNames.ts` の `SP` に集約する。

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
| 12 | DB | sproc ゲートウェイ疎通 | 7 sproc の代表 @操作 を EXEC | 結果セット返却・THROW 50404/50409/50000 が仕様どおり | 済 |  |
| 13 | DB | REST 縦貫 + 監査ミラー | rest モードで login〜API〜logout | セッション作成/失効・監査ログが DB に記録 | 済 |  |
| 14 | 編集（E2E） | 赤入れ表示 | 文言を置換 → トグル OFF/ON → パーツ選択 → autosave | 旧文言が `del[data-redline]` で出る／OFF で消える／選択パーツの装飾が外れる／draft に `data-redline` が無い | 済 |  |

> 検証環境（2026-08-02）: SQL Server 2022 Express LocalDB + ODBC Driver 17 + msnodesqlv8 4.5.0
> （Node 24 prebuild）。本番ターゲット SQL Server 2012 上での再検証は未実施
> （2012 非互換構文の不使用は静的確認済み）。
