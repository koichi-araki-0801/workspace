# editor: テンプレ生成器の起動基盤と旧 editor/data の撤去 — 設計

- 日付: 2026-10-01
- 対象: `editor/server`（generate・config・serve）、`editor/scripts/init-data-repo.ps1`、`offline/` の事前確認、ルートの `.gitignore`・`biome.json`・`scripts/clean.mjs`、`editor/appconfig.example.json`、文書
- 位置付け: 作成タブの「新規作成」が呼ぶ Python のテンプレ生成器について、起動のしかた・安全策・旧データ構成の名残を整える。生成器との入出力の約束（契約）の作り直しは範囲外（後日、ユーザーが指定する）。

## 1. 目的と成功条件

### 目的

- 本物の生成器（社内の別サーバ・共有フォルダにある既存ツール）を、editor から安全に起動できるようにする。
- 起動コマンドをリポジトリの方針（`py -3.13`）に揃え、起動できない環境を最初の「新規作成」より前に知らせる。
- 旧 `editor/data` 構成の名残（移行機能・保護設定・例の設定・古い表記）を撤去する。

### 成功条件

1. 既定の設定で、生成器は `py -3.13 <script>` として起動される。`PYTHON_BIN` に絶対パスを指定すれば、それがそのまま使われる。
2. サーバの起動ログで、生成器の Python が 3.13 でない・見つからない・指紋が未設定、のいずれも分かる。
3. 生成器のスクリプトの SHA256 を設定した場合、内容が変わっていれば生成は拒否され、ログに残る。
4. 生成器の子プロセスには、許可した環境変数と検証済みの属性だけが渡る。秘密値（`HTTPS_PFX_PASSPHRASE`・`DB_CONN_EXTRA` など）は渡らない。
5. 生成の同時実行は上限を超えない。超えた要求は待たずに即エラーになる。
6. 元テンプレを指定した生成（`basedOnTemplateId`）が、サーバの本当のテンプレ置き場（`config.templatesDir`）を読む。
7. リポジトリから `editor/data` への参照と、それを前提とした移行機能・保護設定が無くなる。この端末の `editor/data` の実データは、消さずにワークスペースの外へ移してある。

### 前提（ユーザー確定）

- 本物の生成器は既存のツールで、社内の別サーバ・共有フォルダにある。editor は設定 `PY_GENERATE_SCRIPT`（appconfig `python.script`）でそのパスを指す。
- 起動コマンドは「bin と引数を分け、起動時に確認する」方式。
- 入出力の約束（契約）は後日指定。今回は現行の「argv の JSON を受け、stdout に HTML を出す」形のまま。
- 旧 editor/data は移行機能まで完全に撤去する。この端末の実データはワークスペースの外へ移す。

## 2. 現状

- 呼び出しは `editor/server/src/generate/pyTemplate.ts` の `execFile(config.python.bin, [config.python.script, JSON.stringify(attrs)], { env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, timeout })`。既定の bin は `python`（AGENTS.md の方針と食い違い、Microsoft Store のスタブに解決される端末では exit 9009 で失敗する）。
- `generate.routes.ts` は検証済みの `attributes` ではなく、リクエスト本文を `generateTemplate` に渡している。サーバが計算した `baseDate` は渡していない。
- 生成の同時実行に上限が無い（PDF ビルドには `maxQueue` がある）。
- `editor/server/scripts/generate_template.py` は入出力の約束だけを実装した仮実装。`basedOnTemplateId` があると、環境変数 `TEMPLATES_DIR` が無ければ旧 `editor/data/templates` を読む。サーバは `TEMPLATES_DIR` を子プロセスへ渡していない（環境変数を丸ごと継承しているだけ）。
- 生成物は `pending/` にだけ書かれ、承認を経て確定する（承認ゲートは迂回されない）。生成器が出した JS は、承認後は変えられない基準になる。つまり生成器そのものと置き場への書き込み権限は、サーバの実行アカウントでのコード実行と同じ重みを持つ。
- 旧 editor/data の名残（dig の調査による）:
  - 動作に影響: `editor/appconfig.example.json` の `paths`（`templatesDir: data/templates` など）、仮実装の fallback、`editor/web/test/fillJinja.dom.test.ts` の実データ系統。
  - 移行機能: `editor/scripts/init-data-repo.ps1` の seed コピー（`editor/data/{templates,css}` から）と追跡解除の案内、運用手順書の警告。
  - 保護設定: ルート `.gitignore` の `editor/data` 行、`biome.json` の除外、`scripts/clean.mjs` の `NEVER_REL` と `clean.test.mjs`。
  - 表記: README のツリー図、`shared/src/index.ts`・`shared/src/repositories/ReviewRepository.ts`・`web/src/lib/formatOutput.ts`・`templatePreviewService.ts`・`config.ts` のコメント、`docs/editor/承認ワークフロー設計.md`。
  - この端末には実データ `editor/data/{css,templates,templates-filled}` がある。

## 3. 設計

### 3.1 起動コマンド

- 設定を `python.bin`（既定 `py`）と `python.args`（既定 `["-3.13"]`）に分ける。環境変数 `PYTHON_BIN` が指定されたときは、`python.args` の既定を空にする（絶対パスの python.exe を直接指す運用のため）。appconfig では `python.args` を明示できる（`PYTHON_BIN` と併用するときも appconfig の値が優先）。環境変数 `PYTHON_ARGS` は設けない（空白分割の曖昧さを避ける）。
- 呼び出しは `execFile(bin, [...args, script, attrsJson])`。
- サーバ起動時に 1 回、`<bin> <args> -c "import sys; print('%d.%d' % sys.version_info[:2])"` を実行する（タイムアウト 10 秒、上記と同じ許可環境変数）。結果を起動ログに出し、次の場合は警告を出す: 起動できない（パスや ENOENT・exit 9009）、版が 3.13 でない。起動は止めない（生成を使わない運用があるため）。
- offline の事前確認（`offline/` の check-requirements 系スクリプト）に、`py -3.13 -c "import sys"` が通ることの確認を足す。失敗時は「Python 3.13 と py ランチャを入れてください」と案内する。

### 3.2 生成器の呼び出しの安全化

- **環境変数の許可リスト**: 子プロセスへ渡すのは `PATH` `SYSTEMROOT` `TEMP` `TMP` `PATHEXT` `COMSPEC` `PYTHONUTF8=1` `PYTHONIOENCODING=utf-8` と、`TEMPLATES_DIR=<config.templatesDir>` だけ。`process.env` を丸ごと渡さない。Windows で py ランチャと Python が動くのに必要な最小限で、実機（py -3.13 で仮実装を起動）で確かめる。
- **渡す属性**: リクエスト本文ではなく、ルートで検証済みの属性（`companyCode` `fundCode` `editionType` `basedOnTemplateId?`）と、サーバが計算した `baseDate` だけを、明示したキーで組み立てて渡す。
- **同時実行の上限**: 同時に起動する生成器は 2、待ち行列は 8。超えたら待たずに 503 相当のエラー（既存の PDF ビルドの上限と同じ扱いとメッセージの形）。設定 `GENERATE_MAX_CONCURRENCY` / `GENERATE_MAX_QUEUE`（`envPositiveNumber` を通す）。
- **生成器の指紋**: 設定 `python.scriptSha256`（環境変数 `PY_GENERATE_SCRIPT_SHA256`）を新設する。
  - 設定されていれば、生成のたびにスクリプトのバイト列を読んで SHA256 を照合し、食い違えば生成を拒否する（エラー応答と、監査ログ・サーバログへの記録）。照合と起動の間の差し替えを狭めるため、照合はその都度行う。
  - 未設定なら照合しないが、サーバ起動時に「生成器の指紋が未設定（共有フォルダ上の生成器を使うなら設定を推奨）」と警告する。
  - 照合できるのは入口のスクリプト 1 本だけで、そこから読み込まれるモジュールは対象外。置き場を読み取り専用にする運用を手順書に書く（3.5）。
- **タイムアウト**: 既存の `python.timeoutMs` のまま。

### 3.3 仮実装の扱い

- `editor/server/scripts/generate_template.py` はテスト用の偽物として残し、名前とコメントでそれと分かるようにする（例: 冒頭の説明を「テスト・local 検証用の偽の生成器。本番は PY_GENERATE_SCRIPT で既存の生成器を指す」に）。e2e と local の検証で使う。
- fallback の `editor/data/templates` を削除し、`TEMPLATES_DIR` が無ければ元テンプレ指定をエラーにする（サーバは 3.2 で必ず渡す）。

### 3.4 旧 editor/data の完全撤去

1. この端末の `editor/data` を `C:\Users\caads\repo-archives\editor-data-seed-2026-10\` へ移す（消さない。移す前に中身の一覧とサイズを記録し、移した後に同じであることを確かめる）。
2. 撤去する:
   - `init-data-repo.ps1` の seed コピー（`editor/data/{templates,css}`）と、追跡解除の案内。
   - ルート `.gitignore` の `editor/data` 行、`biome.json` の除外、`scripts/clean.mjs` の `NEVER_REL` の該当と `clean.test.mjs` の該当テスト。
   - `editor/appconfig.example.json` の `paths`（`templatesDir` `cssDir` `pendingDir` など、旧構成を指す行）。例は `dataRoot` だけを示すか、`paths` を省く。
   - 仮実装の fallback（3.3）。
   - `editor/web/test/fillJinja.dom.test.ts` の実データ系統（`editor/data` を読み、無ければスキップしていたもの）。同じ観点が他のテスト（fixtures）で押さえられていることを確かめ、無ければ fixtures に最小の代替を置く。
3. 表記を直す: README のツリー図、2 章に挙げたコメント、`docs/editor/承認ワークフロー設計.md`、運用手順書の警告。
4. 撤去後に `grep -rn "editor/data\|data/templates\|data/css"` で、テストの一時ディレクトリ以外に残っていないことを確かめる。

### 3.5 文書

- 運用手順書: 設定表に `python.args` / `python.scriptSha256`（`PY_GENERATE_SCRIPT_SHA256`）/ `GENERATE_MAX_CONCURRENCY` / `GENERATE_MAX_QUEUE`、生成器の置き方（共有フォルダは editor サーバの実行アカウントから読み取り専用、書き込めるのは生成器の保守者だけ。dataRoot 配下には置かない）、指紋の取り方（`certutil -hashfile <script> SHA256`）と更新手順（生成器を更新したら指紋も更新）。起動ログの警告の意味。
- 設計書: 「Python 生成器の本番統合が未了」の課題を、配置と安全策が済み、契約は後日、という状態に更新する。
- OFFLINE.md・README の Python の記述を `py -3.13` に揃える。

### 3.6 テスト

- 設定: `python.bin` / `python.args` の既定、`PYTHON_BIN` 指定時に args が空になること、appconfig の `python.args` の優先、`PY_GENERATE_SCRIPT_SHA256` の形式検査（64 桁の 16 進以外は起動エラー）、`GENERATE_MAX_*` の数値検査。
- 呼び出し: 子プロセスに渡る環境変数が許可リストだけであること（秘密の環境変数を立てて渡らないことを確かめる）、`TEMPLATES_DIR` が `config.templatesDir` であること、渡る属性が検証済みのキーだけで `baseDate` を含むこと（本文に余計なキーを足しても渡らない）。
- 指紋: 一致で起動、不一致で拒否とログ、未設定で照合しない。
- 同時実行: 上限 2・待ち 8 を超えると即エラー、終わると次が流れる。
- 起動時確認: 版 3.13 で警告なし、版違い・起動失敗で警告（`execFile` を差し替えて確かめる）。
- 仮実装: `TEMPLATES_DIR` で元テンプレを読む、無ければエラー（Python のテストを足すか、サーバ側の結合テストで確かめる）。
- 撤去: `clean.test.mjs` などの更新後のテストが通ること、grep の残りが無いこと。
- 実機: `py -3.13` で仮実装を起動し、local モードで「新規作成」が動くこと（元テンプレ指定あり・なし）。

## 4. 範囲外・残るリスク

- 生成器との入出力の約束（契約）の作り直し（stdin/JSON 化、契約バージョン、生成時点の出力検査、規約の文書化）。後日、ユーザーが指定する。
- 生成器が出す HTML の検査は、従来どおり PDF ビルドと承認の時点で行われる。
- 指紋は入口のスクリプトだけを守る。生成器が読み込むモジュールの改ざんは、置き場の読み取り専用運用で防ぐ。
- 生成器が共有フォルダにあるため、ネットワーク障害時は生成が失敗する（タイムアウトとエラー応答で知らせる）。

## 5. 却下した案

- 起動コマンドをセットアップ時に絶対パスへ解決して appconfig に書く: ユーザーが「bin と引数を分け、起動時に確認する」を選んだ。
- 生成器を dataRoot 配下に置く: データの git リポジトリに実行コードが入り、共有上で書ける人が任意コードを実行できる。
- `process.env` を丸ごと渡したまま秘密値だけ削る（拒否リスト）: 新しい秘密値が増えたときに漏れる。
- 起動時の版の確認に失敗したら起動を止める: 生成を使わない運用（local・閲覧専用）まで止まる。
