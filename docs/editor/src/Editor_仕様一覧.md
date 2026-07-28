---
audience: spec
title: Editor 仕様一覧（画面項目 / 入出力 / DB / テスト）
---

対象: 運報自動化 Editor（フェーズ2 REST + SQL Server）・ 版 1.0 ・ 出典: editor/ 実装コード・DDL・テスト

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
| 11 | ユーザー管理 | ロール | `role` | `admin \| editor \| viewer` | ○ | admin のみユーザー管理可（isAdmin） |
| 12 | ユーザー管理 | 無効 | `disabled` | `boolean` |  | 無効化フラグ |
| 13 | 編集 | テンプレートID | `templateId` | `string` | ○ | 下書き保存（PUT /templates/:id/draft）対象 |
| 14 | 編集 | HTML | `html` | `string` | ○ | GrapesJS 本文。確定保存はファイル保存 |
| 15 | 編集 | CSS | `css` | `string` | ○ | 本文スタイル |

# 入出力定義(REST API)

| No | Method | パス | 認証 | 入力 | 出力 |
|:--:|:--:|---|:--:|---|---|
| 1 | `POST` | `/auth/login` |  | LoginRequest（username, password） | LoginResult（user, mustChangePassword） |
| 2 | `POST` | `/auth/init-password` |  | PasswordInitRequest（新パスワード） | 204 / 更新後 User |
| 3 | `POST` | `/auth/logout` | Cookie | — | 204（セッション失効） |
| 4 | `GET` | `/auth/me` | Cookie | — | User（未認証は401） |
| 5 | `GET` | `/templates/options` | ○ | companyCode, fundCode, baseDate, editionType（任意） | DropdownOptions |
| 6 | `GET` | `/templates/series` | ○ | companyCode, editionType（必須） | シリーズファンド一覧 |
| 7 | `GET` | `/templates` | ○ | 属性フィルタ（DropdownQuery） | TemplateMeta[] |
| 8 | `GET` | `/templates/:id` | ○ | id | Template（meta + html + css） |
| 9 | `GET` | `/templates/:id/draft` | ○ | id | TemplateDraft |
| 10 | `PUT` | `/templates/:id/draft` | ○ | SaveDraftRequest（templateId, html, css） | 204 |
| 11 | `PUT` | `/templates/:id` | ○ | ConfirmSaveBody（html, css, fundCode） | TemplateMeta（確定保存） |
| 12 | `GET` | `/funds/:fundCode/sample-data` | ○ | fundCode | SampleData（プレビュー context） |
| 13 | `POST` | `/generate` | ○ | GenerateRequest（companyCode, fundCode, editionType, basedOnTemplateId?, isRedemption?） | GenerateResult（テンプレート骨子 + draft） |
| 14 | `GET` | `/parts` | ○ | — | PartCatalogItem[] |
| 15 | `GET` | `/parts/classification-options` | ○ | — | 分類ドロップダウン候補 |
| 16 | `GET` | `/templates/:templateId/parts/:partId/history` | ○ | templateId, partId | パーツ変更履歴 |
| 17 | `POST` | `/build` | ○ | BuildInlineRequest（html, css, size, singleDoc） | PDF（vivliostyle） |
| 18 | `POST` | `/build/project` | ○ | プロジェクト zip | PDF |
| 19 | `GET` | `/preview/:id` | ○ | id | プレビュー（Vite proxy） |
| 20 | `POST` | `/preview` | ○ | html/css | プレビューセッション開始 |
| 21 | `GET` | `/history/edit` | ○ | — | 編集履歴一覧 |
| 22 | `GET` | `/history/pdf` | ○ | — | PDF出力履歴一覧 |
| 23 | `GET` | `/history/create` | ○ | — | 作成履歴一覧 |
| 24 | `GET` | `/templates/:templateId/versions` | ○ | templateId | 版一覧（比較用） |
| 25 | `GET` | `/snapshots/:historyId` | ○ | historyId | スナップショット本文 |
| 26 | `GET` | `/users` | admin | — | User[] |
| 27 | `POST` | `/users/:id/reset-password` | admin | id | PWリセット結果（要PW変更） |

# DB定義(テーブル)

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
| ユーザー | ロール | `NVARCHAR(16)` |  |  |  | admin / editor / viewer |
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

# DBストアド(sproc)

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
| 9 | `user` | PW初期化 | 初回PW設定 |
| 10 | `part` | 分類候補 | 分類ドロップダウン候補（カテゴリ/大/中/小） |
| 11 | `part` | 一覧 | 分類フィルタでパーツカタログ一覧 |
| 12 | `sample` | 取得 | ファンド別サンプルデータ取得 |
| 13 | `sample` | 登録 | ファンド別サンプルデータの upsert |
| 14 | `session` | 作成 | セッション発行 |
| 15 | `session` | 取得 | セッション検証（期限/失効）＋ユーザー結合 |
| 16 | `session` | 失効 | ログアウトで失効 |
| 17 | `audit` | 登録 | 監査イベント記録（logger.ts 連携） |
| 18 | `audit` | 検索 | イベント絞込で最新500件取得 |

# テスト仕様

| No | 区分 | テスト観点 | 手順 | 期待結果 | 結果 | 確認者 |
|:--:|---|---|---|---|:--:|---|
| 1 | 認証(E2E) | 未認証アクセス | 保護ページへ直接アクセス | ログイン画面へリダイレクト | 未 |  |
| 2 | 認証(E2E) | ログイン成功 | 正しいID/PWでログイン | 編集（/edit）タブへ遷移 | 未 |  |
| 3 | 認証(E2E) | ログイン失敗 | 不正なパスワードで送信 | エラー表示・ログイン画面に滞在 | 未 |  |
| 4 | API | OpenAPI パス網羅 | openapi.test.ts を実行 | 16パスとスキーマが定義済み | 未 |  |
| 5 | API | 公開エンドポイント | /health /auth/login の security | security:[]（認証不要） | 未 |  |
| 6 | 認可 | 管理者限定 | viewer で /users を呼ぶ | 403（requireAdmin） | 未 |  |
| 7 | ドメイン | ユーザー検証 | username に記号を含めて検証 | 『半角英数字とアンダースコアのみ』 | 未 |  |
| 8 | ドメイン | 重複ID | 既存ID（大小違い）で作成 | 『既に使われています』 | 未 |  |
| 9 | 入力検証 | zip アップロード | projectInput.test.ts | 不正zipを拒否 | 未 |  |
| 10 | 生成 | テンプレ生成 | pyTemplate.test.ts | 骨子HTMLを生成 | 未 |  |
