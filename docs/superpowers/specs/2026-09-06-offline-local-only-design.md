# オフライン配布機構の縮退 — 設計

- 日付: 2026-09-06
- 状態: 実装済み（2026-09-06。E2E 実測: monorepo 約4分48秒、python-tools 約23秒）
- 対象: monorepo（workspace）と python-tools の両リポジトリ。python-tools 側の作業も本書を正典とする
  （python-tools には spec を置かず、計画ファイルから本書を参照する）。
- 目標: オフライン配布機構を「この端末でバンドルを作って GitHub Releases へ上げる / 他端末は
  git clone と HTTPS 取得で環境を作る」の 2 役だけに縮退し、それ以外（署名・pin・一時 Public 化・
  コミットフック連動・ソース ZIP 取得）を GitHub から消す。消した実装はリポジトリ内の
  git 管理外フォルダへ退避し、何を・なぜ消したかが後から分かる形にする。

## 1. 決定事項（ユーザー確認済み）

| 論点 | 決定 |
|---|---|
| 残す機能 | ローカルでのバンドル生成（この端末のみ）と、他端末でのバンドル取得・展開 |
| 他端末のソース取得 | `git clone`（リポジトリは Public）。setup はソースを取得しない |
| 他端末のバンドル取得 | GitHub Releases（タグ `offline-bundle-v1`）から HTTPS 直取得。`gh` 不要 |
| 既存 Release とタグ | 残す。Release は配布経路として現役。タグは固定し、以後動かさない |
| 検証 | content-key 整合（`bundle.key` と手元の lockfile / requirements）のみ。署名・pin は撤去 |
| コミットフック | post-commit の publish 呼び出し・ローリングタグ移動、pre-push の「タグのみ push は CI スキップ」分岐をともに撤去 |
| GitHub から消す部分の置き場 | リポジトリ内の git 管理外フォルダ `local-only/` |
| バンドル生成スクリプトの置き場 | `local-only/`（この端末専用。GitHub には展開側だけが残る） |
| python-tools | monorepo と同じ方針で揃える。`setup_dev.py` の wheelhouse 必須（fail-closed）は維持 |

## 2. 全体像（変更後）

```
この端末（配布担当）                         他端末
────────────────────────────────           ────────────────────────────────
local-only/offline-publish/                 git clone <repo>
  publish-offline-bundle  ── 生成 ──┐        offline\setup-offline.bat
                                    │          ├ 直下 / bk\ にバンドルがあればそれを使う
                                    ▼          ├ 無ければ Release から HTTPS 直取得
GitHub Releases offline-bundle-v1              │   offline-deps-bundle.tar.gz / .sha256 / bundle.key
  offline-deps-bundle.tar.gz  ─────────────▶   ├ .sha256 で転送破損を検査
  offline-deps-bundle.tar.gz.sha256            ├ 展開
  bundle.key                                   ├ bundle.key と手元の content-key を照合
                                               └ install / build / git-tools / native-prebuilds
```

- 整合の根拠は content-key（`offline/lib/content-key.ps1` / `offline/lib/bundle_common.py`。
  変更しない）。ソース側の lockfile / requirements / manifest が Release のバンドルと組でなければ
  setup は中止する。
- **残余リスク（受容）**: Release アセットのすり替えは検出しない。`.sha256` は配信元と同じ場所から
  取る値なので転送破損の検知にしか使えない。Release はリポジトリ所有者だけが更新でき、配布先は
  同じ所有者の Public リポジトリを clone している前提で受け入れる。
- **依存を変えたら手動で publish する**: post-commit の自動連動を撤去するため、lockfile /
  requirements / manifest を変えたのに publish を忘れると、他端末の setup は content-key 不一致で
  止まる（黙って古い重量物を使うことはない）。この運用は README-offline に明記する。

## 3. 追跡側 `offline/`（GitHub に残す。他端末が実行する）

### 3.1 monorepo

| ファイル | 変更 |
|---|---|
| `offline/setup-offline.ps1` / `.bat` | 旧 `setup-offline`（DL 版）と `setup-offline-local` を **1 本に統合**。直下 / `bk\` にバンドルがあればそれを使い、無ければ Release から HTTPS 直取得する。ソース ZIP 取得・pin 照合・分離署名検証・receipt・`-DangerouslySkipVerification` を撤去。`.sha256` 照合 → 展開 → content-key 照合 → corepack 登録 → `pnpm install --offline` → build → Playwright 配置 → git-tools 展開 → native-prebuilds 展開 → DL 物の `bk\` 退避、の順。引数は `-SkipBuild` / `-InstallTortoiseGit` / `-Owner` / `-Repo` / `-Tag` を維持 |
| `offline/setup-offline-local.ps1` / `.bat` | 削除（統合先へ） |
| `offline/publish-offline-bundle.ps1` / `.bat` | 削除（`local-only/` へ） |
| `offline/new-bundle-signing-key.ps1` / `.bat` | 削除 |
| `offline/bundle-signing.pub.xml` / `offline/pinned-release.txt` | 削除 |
| `offline/lib/content-key.ps1` / `offline/lib/git-tools.ps1` | 変更なし |
| `offline/lib/verify.ps1` | requirements 検査（`Test-OfflineRequirementLine` / `Test-OfflineRequirementsFile` / `Assert-OfflineRequirementsFile`）・git-tools manifest 解決（`Get-GitToolsManifestEntries` / `Resolve-VerifiedManifestFile`）・`Assert-LocalRepoRoot`・`Assert-FileSha256` を残す。pin（`Test-PinnedCommitId` / `Get-OfflinePin`）・署名（`New-OfflineSigningKeyPair` / `New-DetachedSignatureBase64` / `Test-DetachedSignature` / `Assert-BundleSignature`）・receipt 3 関数を削除 |
| `offline/lib/verify.Tests.ps1` | 削除した関数の Describe（pin / 署名 / receipt）を削除。残す関数のテストは維持 |
| `offline/README-offline.txt` | 全面書き直し。「git clone → `offline\setup-offline.bat`」の手順と、配布担当向けの「依存を変えたら `local-only\offline-publish\publish-offline-bundle.bat` を実行」の運用、Release の役割、残余リスクを書く。一時 Public 化・署名鍵・pin・post-commit の節は削除 |

`.sha256` の照合には既存の `Assert-FileSha256` を使う（期待値の出所が pin から Release の
`.sha256` に変わるだけ）。

### 3.2 python-tools

| ファイル | 変更 |
|---|---|
| `offline/setup_offline.py` / `setup-offline.bat` | 書き直し。直下にバンドルがあればそれを使い、無ければ Release から HTTPS 直取得（`urllib` のみ。`gh` 経路は撤去）→ `.sha256` 照合 → content-key 照合（展開前。理由は現行 docstring の I-3 を引き継ぐ）→ 展開。pin・公開鍵・`cryptography` 導入・署名検証・source zip 照合（手順 1, 6, 7, 8）を撤去 |
| `offline/publish_bundle.py` / `publish-bundle.bat` | 削除（`local-only/` へ） |
| `offline/new_signing_key.py` / `bundle-signing.pub.pem` / `pinned-release.txt` / `dev-requirements.txt` | 削除。`dev-requirements.txt` は `cryptography` 専用だったため不要になる |
| `offline/lib/bundle_common.py` | requirements 列挙・content-key 算出・`bundle.key` 読み書きを残す。pin（`PublishPin` / `format_pin` / `write_pin` / `read_pin`）と Ed25519 署名 6 関数を削除 |
| `scripts/check_requirements.py` | pip 入口ガード（`KNOWN_PIP_ENTRYPOINTS` / `has_check_requirements_marker` / `find_pip_call_files`）を `publish_bundle.py` からここへ移す。ガードの意味（検査を経ない pip 入口を作らない）は不変で、`ci.yml` のコメントが指す正典もここになる。`KNOWN_PIP_ENTRYPOINTS` から `offline/publish_bundle.py`（退避）と `offline/setup_offline.py`（`cryptography` 導入の撤去で pip を呼ばなくなる）を外す。走査は `git ls-files` なので `local-only/` は対象にならない |
| `scripts/setup_dev.py` / `scripts/lib/build_venv.py` | 案内文言の `offline\setup-offline.bat` はそのまま（スクリプト名は変えない） |
| `offline/README-offline.md` | 全面書き直し（3.1 と同内容を python-tools 向けに） |

`dev-requirements.txt` の削除で content-key が変わるため、実装後にこの端末で 1 回 publish して
Release の `bundle.key` を更新する（5 章）。

## 4. `local-only/`（git 管理外。この端末にだけ在る）

両リポジトリの直下に置き、`.gitignore` に `local-only/` を足す。

```
local-only/
  README.md                      … このフォルダの役割（git 管理外・この端末専用・2 つの下位フォルダの説明）
  offline-publish/               … バンドル生成 + Release 更新（配布担当が手動実行）
    publish-offline-bundle.ps1 / .bat     （monorepo）
    publish_bundle.py / publish-bundle.bat（python-tools）
  archive-github-dist/           … 変更前の実装をそのまま複製（保守しない。参照専用）
    README.md                    … 退避元コミット SHA・退避した理由・Release とタグの扱い
    offline/                     … 変更前の offline/ 一式
    hooks/                       … 変更前の .husky/post-commit（monorepo）/ scripts/hooks/post_commit.py・pre_push.py（python-tools）
```

- **`offline-publish/`** は旧 publish から「重量物の生成 → tar → `.sha256` と `bundle.key` の生成 →
  `gh release upload --clobber`」だけを残す。署名・pin 生成・ローリングタグ移動・一時 Public 化・
  Release notes の生成は持たない。Release 側の `bundle.key` と手元の content-key が一致すれば
  再生成を skip し、`-Force` / `--force` で強制する。lib は追跡側の `offline/lib`（相対パス
  `..\..\offline\lib`）を dot-source / import する。**HEAD が push 済みであること**は引き続き
  要求する（他端末が clone する HEAD と組の重量物を上げるため）。
- **`archive-github-dist/`** は動かすことを前提にしない。verbatim 複製で、`$PSScriptRoot` 相対の
  参照が壊れていてもよい。README に「Release `offline-bundle-v1` は配布経路として現役だが、
  ローリングタグは固定で自動 Source code は陳腐化する（ソースは git clone で配る）」と書く。
- コメント規約の機械検査（`scripts/check-comments.py` / `scripts/check_comments.py`）は
  ファイルシステム走査で `.ps1` / `.py` を拾うため、`local-only` を走査除外に足す
  （archive 内の `.ps1` は `.bat` 併設の例外リストがパス依存で一致しないため）。

## 5. コミットフック・CI・付随スクリプト

### 5.1 monorepo

| 対象 | 変更 |
|---|---|
| `.husky/post-commit` | 削除 |
| `scripts/pre-push.mjs` / `pre-push.test.mjs` | 「タグのみ push は CI スキップ」分岐（`decidePrePushAction` の tag 判定・stdin ref 解析）を撤去。ブランチ push は従来どおり `ci:affected` |
| `git config offline.publish` | `--unset`（この端末の clone。作業手順として実行） |
| `.gitignore` | `local-only/` 追加。`offline-deps-bundle.tar.gz.sha256` / `.sig` / `_bundle_verify/` の行を整理（`.sha256` は publish が直下に生成するため ignore は残す。`.sig` と `_bundle_verify/` は削除） |
| `scripts/clean.mjs` | `BUNDLE_FILES` のコメントから publish への参照を `local-only/offline-publish` へ更新。`deep` の案内文言 `offline/setup-offline-local` → `offline/setup-offline` |
| `scripts/ci-affected.mjs` | 変更なし（`offline/` 領域 → `ci:offline` の Pester は残る lib 分で継続） |
| `scripts/check-comments.py` | `ps1_skip_dir_names` に `local-only` を追加。`bat_pairing_exceptions` は変更なし |
| ローカル `CLAUDE.md` | post-commit の記述（タグ移動・`OFFLINE_PUBLISH_SKIP`）と pre-push の「タグのみの push は CI をスキップ」を削除 |

### 5.2 python-tools

| 対象 | 変更 |
|---|---|
| `scripts/hooks/post_commit.py` | `publish_tag_only` と `PUBLISH_BUNDLE` を撤去。auto-push のみ |
| `scripts/hooks/pre_push.py` | タグのみ push のスキップ判定（`parse_remote_refs` / `decide_pre_push_action` / `count_ahead_of_upstream`）を撤去。常に check_comments → pytest 6 段 |
| `scripts/test_python_tools_scripts.py` | publish / signing / pin / タグ / gh 取得 / pre-push タグ判定のテストを削除。`setup_offline` の HTTPS 取得・`.sha256` 照合・content-key 照合・展開のテストと、移設した pip 入口ガードのテストを維持・追加 |
| `.github/workflows/ci.yml` | コメント中の正典参照を `scripts/check_requirements.py` へ |
| `.gitignore` | `local-only/` 追加。`*.key.pem` は削除 |
| `scripts/check_comments.py` | 走査除外に `local-only` を追加 |

## 6. docs

| ファイル | 変更 |
|---|---|
| ルート `README.md`（monorepo） | 「最初に覚える 3 コマンド」のセットアップを `offline\setup-offline.bat`（または `pnpm install`）へ。入口一覧から `setup-offline-local` と `publish-offline-bundle` の行を削除。「タグのみの push は CI をスキップ」段落を削除 |
| `docs/トラブルシュート.md` | post-commit の publish に関する項（`offline.publish` / `OFFLINE_PUBLISH_SKIP`）を削除 |
| `docs/editor/src/デプロイ運用手順書.md` | `offline/setup-offline.bat` の記述は名称そのまま。「持ち込み・展開」の前提を「git clone + Release 取得（またはバンドルを直下に置く）」に合わせる |
| `docs/editor/src/設計書.md` | 「重量物は GitHub Releases、`offline/` 配下のスクリプト群」の一文を「生成は配布担当の端末の `local-only/offline-publish`」へ |
| `docs/コメント規約.md` | 付録 C の例文（publish の comment-based help）を、残る `setup-offline.ps1` の例へ差し替え |
| python-tools `README.md` | セットアップ節と「開発フロー（Git hooks）」節（post-commit の 2 項目目・pre-push のタグスキップ）を更新 |
| python-tools `docs/*/src/設計書.md` | offline / wheelhouse の記述を新手順へ |
| `docs/superpowers/plans/*` | 履歴として変更しない |

## 7. 検証

1. **単体**: monorepo `pnpm run ci:offline`（Pester）と `pnpm run test:scripts`、python-tools
   `py -3.13 -m pytest scripts` が緑。
2. **publish（この端末）**: python-tools は content-key が変わるため `local-only\offline-publish\publish-bundle.bat`
   で Release を更新する。monorepo は content-key が変わらないため skip になることを確認する
   （`-Force` は使わない）。
3. **他端末相当の E2E**: `C:\Users\Public\offline-verify\` に両リポジトリを `git clone` し、
   バンドルを置かずに `offline\setup-offline.bat` を実行して、HTTPS 取得 → `.sha256` → content-key →
   展開 → install / build まで完走する。直下にバンドルを置いた場合に取得を省くことも確認する。
   検証フォルダの `DATA_ROOT` / `GIT_BIN` は実データを指さないよう上書きする。
4. **回帰**: monorepo `pnpm run ci`、python-tools の pre-push 一式が緑。
5. **フック**: monorepo でコミットしても Release のタグが動かないこと（`git ls-remote --tags` の SHA が
   不変）。python-tools の post-commit が auto-push だけを行うこと。

## 8. 触らないもの

- GitHub Releases の既存アセットとタグ `offline-bundle-v1`（publish が `--clobber` で上書きするだけ）。
- `offline/lib/content-key.ps1` / `offline/lib/bundle_common.py` の content-key 算出ロジック
  （Release の `bundle.key` との互換を保つ）。
- `setup_dev.py` の wheelhouse 必須（fail-closed）と `build_venv.py`。
- `scripts/ci-affected.mjs` の領域定義。
