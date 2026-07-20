# 開発ガイド（CONTRIBUTING）

小規模チーム（2〜3名・TS初心者歓迎）で迷わず開発するためのハブ。**まずこのページを上から読めば開発を始められます。**

> **前提**: editor はリポジトリ直下の **pnpm モノレポ**の一部（`editor/shared` `editor/server` `editor/web`）。
> コマンドは**リポジトリルート**から `pnpm` で実行します（editor 単体の `package.json` はありません）。
> パッケージマネージャは `pnpm@11.8.0+`、Node は 24 系（`editor/.nvmrc` = 24）。

## 1. セットアップ

```bash
# Node のバージョンを合わせる（editor/.nvmrc = 24）。nvm 利用者は：
nvm use            # （未導入なら Node 24 系を入れる）

pnpm install       # 依存をインストール（husky フックも自動で有効化されます）
pnpm dev           # shared ビルド後、Express(:24680) と Vite(:24681) を並行起動
```

Windows は `editor/start.bat`（ダブルクリック=本番ローカル / `dev` / `rest` 等）でも起動できます。
ブラウザで http://localhost:24681 → デモログイン `admin / admin`（または `editor / editor`）。

## 2. コマンド早見表（ルートから）

| やりたいこと | コマンド |
|---|---|
| 開発サーバ起動 | `pnpm dev` |
| 型チェック（全 workspace） | `pnpm typecheck` |
| テスト | `pnpm test` |
| テスト＋カバレッジ（85% 閾値） | `pnpm test:coverage` |
| 未使用 export / 依存の検出 | `pnpm knip` |
| **整形＋Lint＋import整理を一括自動修正** | `pnpm check` |
| 整形だけ | `pnpm format` |
| Lint だけ（修正なし） | `pnpm lint` |
| 本番ビルド | `pnpm build` |
| CI 集約（push 前に再現） | `pnpm ci` |

> **基本は `pnpm check` を覚えれば OK。** エディタ（VS Code）なら保存するたびに自動で整形・import 整理が走るので、普段は手で実行する必要すらありません。

## 3. ツールチェーン

- **Biome**（Lint + Formatter を1つに統合・対象は `editor/**`）。設定は `biome.json`。ESLint / Prettier は使いません（混在させないでください）。
- **VS Code 推奨**：初回起動時に推奨拡張（Biome / Vue(Volar) / Tailwind）のインストールを促されます。`.vscode/settings.json` で「保存時に自動整形・自動修正」が有効です。
- **コミット時**：`husky` + `lint-staged` が、ステージした `editor/**` に自動で `biome check --write` をかけます。スタイル崩れはコミット時に勝手に直ります。
- **CI**：オフライン運用のため pre-push で `pnpm ci`（`check:comments → check:ci → typecheck → test:coverage → build → test:e2e`）をローカル集約実行します。GitHub Actions は保険として残置。

## 4. ディレクトリ地図（どこに何を置くか）

```
shared/src/
  index.ts            ← 型 DTO の「真実の源」。web/server 両方が参照
  result.ts errors.ts ← Result<T,E> と AppError（例外を握りつぶさない基盤）
  domain/             ← 値オブジェクト＋純粋関数（template/user/history）
  repositories/       ← 集約ごとの Repository インターフェース（契約）
web/src/
  features/<画面>/     ← 画面単位のまとまり。services/ composables/ viewmodels/ components/
  components/ui/       ← 汎用 UI 部品（shadcn-vue 由来）
  lib/                 ← 画面に依存しないロジック（jinjaMask, useAsyncResult, useCascadingSelect 等）
  api/repositories.ts  ← Repository コンテナ＋DI。★VITE_API_MODE で local / rest を切替える唯一の点
  api/local/           ← Phase1 のローカル実装（fixtures + localStorage）。集約ごとに *Repo.ts
  api/rest/            ← Phase2 の REST 実装（同契約・/api を叩く）。集約ごとに *Repo.ts
  stores/              ← Pinia ストア（横断状態。例: auth.ts）
  router/              ← ルーティング定義 + 認証 navigation guard（authGuard）
server/src/
  routes/              ← API エンドポイント（*.routes.ts）。app.ts に登録
  auth/                ← セッション/Cookie・初回パスワード初期化
  db/                  ← SQL Server アクセス（sproc ゲートウェイ。Phase2）
  vivliostyle/ generate/ ← PDF/preview（vivliostyle CLI）・Python 生成器アダプタ
data/                  ← テンプレ(.html)・CSS（サーバが参照。整形対象外・git 管理外）
```

**レイヤーの責務**: Repository（throw→Result の境界）→ Service（業務ルール＋repo合成、Result を返す）→ Composable/Store（reactive 状態）→ 画面（表示）。Service/Repository は必ず `Result<T,E>` を返し、`useAsyncResult` か `isErr` で必ず分岐する（例外を握りつぶさない）。

**よくある追加作業の置き場所**

- 新しい画面を足す → `web/src/features/<名前>/<名前>View.vue` を作り、`web/src/router/index.ts` にルート追加。
- 新しいデータ型を足す → `shared/src/index.ts`（DTO）または `shared/src/domain/`（値オブジェクト・純粋関数）に追加。
- 新しい API を足す → 該当 `shared/src/repositories/*Repository.ts` にメソッド（`Promise<Result<…>>`）を追加 → `web/src/api/local/*Repo.ts` と `web/src/api/rest/*Repo.ts` の両実装を更新 → 必要なら Service を足し、画面は `useXxxService()` 経由で呼ぶ。
- サーバの新エンドポイント → `server/src/routes/` に追加し、`server/src/app.ts` に登録。

## 5. コーディング規約

- **言語**: TypeScript（strict 有効）。`any` は原則禁止。やむを得ず使う場合は理由コメントを必ず添える。
- **Vue**: 単一ファイルコンポーネント + `<script setup lang="ts">` に統一（Options API は使わない）。
- **命名**: ファイルは原則 `kebab-case`（Vue コンポーネントは `PascalCase.vue`）、関数・変数は `camelCase`、型・コンポーネントは `PascalCase`。
- **整形**: 2スペース / シングルクォート / セミコロンあり / 末尾カンマ。**手で整えなくてOK** — 保存または `pnpm check` が直します。
- **import 整理**: 自動。並べ替えに逆らわないでください。
- **未使用の変数・import**: 自動削除されます（保存時 / `pnpm check`）。
- **テスト**: ロジック（`lib/` など）を変えたら `web/test/` にテストを足す/直す。`pnpm test` が緑であること。

## 6. コミット規約（Conventional Commits・最小セット）

`種別: 内容` の形式で書きます。例：`feat: シリーズファンド作成を追加`

| 種別 | 用途 |
|---|---|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `refactor` | 挙動を変えない内部改善 |
| `docs` | ドキュメントのみ |
| `chore` | ビルド・設定・依存など |
| `test` | テストの追加・修正 |

## 7. 困ったとき（初心者向けヒント）

- **赤い波線/型エラーが出る** → メッセージの「`Type 'X' is not assignable to 'Y'`」は「X を Y として使おうとしている」の意味。`shared/src/index.ts` の型定義を確認すると解決の糸口になることが多いです。
- **保存しても整形されない** → 推奨拡張「Biome」が入っているか確認（左下に Biome が出ます）。`.vscode/extensions.json` から入れ直せます。
- **コミットできない（フックで止まる）** → `lint-staged` が直せない Lint エラーが残っています。`pnpm check` を実行してエラー内容を読み、手で修正してから再コミット。
- **`pnpm dev` が動かない** → `nvm use` で Node 24 になっているか、`pnpm install` 済みかを確認。
- **CI が落ちた** → ローカルで `pnpm ci` を流すと、push 前フックと同じ内容を再現できます。
