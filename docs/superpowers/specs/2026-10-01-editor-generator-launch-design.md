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

## 6. 追補（2026-10-02）: PATH 上の python を既定にする・旧構成の片付けをフォント移設パッチへ

実装後、ユーザーから次の 2 点の前提が示された。

- 配置先の端末では、Python はユーザー環境変数 `PATH` で通す（py ランチャは前提にしない）。
- 本番環境はこれから作る。リポジトリ内の旧 `editor/data` を実データとして使っている環境は無い。

### 6.1 起動コマンドの既定を `python` にする（3.1 を改める）

- 既定を `python.bin = python`、`python.args = []` にする。`python` は PATH から探される。`-3.13` のような版指定は付けない。
- 版の固定は、起動時の確認（3.1 の `-c` による版の確認）で担保する。3.13 でなければ警告する。Microsoft Store の偽物（WindowsApps）に当たった場合は、exit 9009 による「起動できない」警告として出る。
- `PYTHON_BIN` と appconfig の `python.bin` / `python.args` による上書きは従来どおり。「bin を明示したら引数の既定は空」という規則は、既定の引数が空になるので実質的に意味を持たなくなるが、残しておいて害はない。
- 子プロセスに渡す `PATH` は、サーバのプロセスの PATH（システムとユーザーの PATH を合わせたもの）である。ユーザー環境変数の PATH を変えたら、サーバは新しいコマンドプロンプトから起動し直す（起動中のプロセスには反映されない）。
- offline の setup の確認（`Test-Python313Launcher`）は、`py -3.13` の代わりに PATH 上の `python` の版が 3.13 であることを確かめる。失敗時の案内は「Python 3.13 を入れ、ユーザー環境変数 PATH に通してください」。止めずに警告する点は従来どおり。
- 開発機の Python 起動を `py -3.13` に揃える方針（AGENTS.md）は、開発作業の話でありこの既定とは別。テスト用の偽の生成器を開発機で動かすテストは、従来どおり `py -3.13` で動かしてよい。

### 6.2 旧構成の片付けをフォント移設パッチ（`editor/patches/2026-10-fonts-to-css/migrate.ps1`）へ統合する

新しいパッチは作らない。既存のフォント移設パッチの確認と `-Apply` に、次を足す。

- **appconfig の置き場が editor のフォルダの中を指している場合**（`paths.templatesDir` / `cssDir` / `pendingDir` など、`editor` 配下へ解決されるもの。旧例の `data/templates` など）:
  - 置き場を解決する段階で、それらの設定を無視して dataRoot 配下の既定を使う。フォント移設の処理が旧い場所を対象にしないようにするため。
  - 確認モードでは「旧構成の置き場の設定を外す」として一覧を出す。`-Apply` では appconfig から該当キーを外す（バックアップは既存の `appconfig.json.bak-<日付>` に含まれる）。
  - 中断はしない。リポジトリ内の旧 `editor/data` を実データとして使っている環境は無い前提（6 章冒頭）。
- **`python.script` が旧い仮の生成器（`server/scripts/generate_template.py`）を指している場合**: `-Apply` でキーを外して既定に戻す。本番の生成器は `PY_GENERATE_SCRIPT` で指すよう案内する。
- **`python.bin` / `python.args`**: 旧例の `python.bin = "python"` は新しい既定と同じなので、外してよい。`python.args` に `-3.13` が残っている場合（今回の作業途中の例を写した場合）も外す。いずれも報告して `-Apply` で外す。
- **editor のフォルダに `data` が残っている場合**: 報告だけする（中身は動かさない・消さない）。
- 元に戻す（`rollback.ps1`）は、既存の appconfig の復元で足りる。
- 何度流しても、済んだ部分は変えない（既存パッチと同じ）。

### 6.3 旧構成を理由に起動を止める検査は持たない（assets の検査も外す）

旧構成の片付けはパッチだけに任せ、サーバ側の「旧構成なら起動を止める」検査は持たない（ユーザー判断、2026-10-02）。構築済み環境（6.4）がフォント移設より前の構成であることを踏まえたうえでの判断で、パッチを流し忘れたときの影響は 6.5 に書く。

- 旧 editor/data 向けの起動時検査は足さない。
- フォント移設（PR #70）で足した次の 2 つの起動時検査を外す。テストも外す。
  - `assertNoRetiredAssetsDir`（環境変数 `ASSETS_DIR` / appconfig `paths.assetsDir` が残っていたら止める）
  - `assertNoLegacyAssetsDir`（`<dataRoot>/assets` が残っていたら止める）
- appconfig の `paths.assetsDir` はスキーマから外す。appconfig は厳格スキーマ（`.strict()`）なので、残っていれば「不明なキー」として起動時に読み込みエラーになる。黙って無視はされない。環境変数 `ASSETS_DIR` は読まなくなる（設定されていても何も起きない）。
- `assertImagesDirOutsideCommittedAreas` は旧構成の検査ではなく、現行構成で画像が承認コミットへ巻き込まれるのを防ぐものなので残す。
- 文書の「新版は旧構成のままでは起動しない」旨の記述（運用手順書、パッチの README、パッチ適用の手順ページ）を、パッチで片付ける形に改める。

### 6.4 既存データ向けの互換処理の整理

ユーザーの補足: 本番の運用はこれからだが、**構築済みの環境が 1 つある**。構築した断面は 2026-09-11 より後で、フォント移設（PR #70）と画像の置き場（PR #71）より前。したがって構築済み環境の data リポジトリは旧い構成（`<dataRoot>\assets` にフォントと js、CSS は `url(../fonts/…)`、`images` 無し）で、`.gitattributes` は旧い無効な行（`* text=lf`）のまま。旧形式メモ（2026-09-02 に変換を導入）と保留の申請（2026-09-03 に撤去）は、その断面以降のデータには無い。

- **残す:** `gitRepo.ts` の `ensureGitattributes` と `.gitignore` の補修（承認時に旧い行を直す）。構築済み環境の `.gitattributes` を直す唯一の経路のため。
- **外す:** 構築済み環境の断面より前の形式を読むための互換処理。その断面以降のデータには現れない。
  - 旧形式メモの変換（`editor/server/src/files/notesFile.ts` の `legacy:<pathKey>` 変換、web の local 版 `noteRepo.ts` の `kind` の読み捨て）。web 側で `legacy:` の ID を前提にしている記述（`CommentPanel.vue`・`NoteBubble.vue` のコメント）も合わせて直す。
  - 撤去した「保留」（`held`）の申請を「承認待ち」に読み替える処理（`reviewFiles.ts`、web の local 版 `reviewRepo.ts`）。
  - web の local 版が使うブラウザ保存領域の旧キーの掃除（`store.ts` の `legacyUndoStacksKeyV1` など）。旧キーがブラウザに残っても読まれないだけで害はない。
- 外す前に、この端末の開発用データ（`C:\Users\caads\editor-data`）に旧形式が無いことを確かめる（2026-10-02 時点で、旧形式メモ・保留の申請とも無し）。開発用データの `.gitattributes` は、次の承認で上の補修が直す。

### 6.5 構築済み環境の更新手順

構築済み環境（6.4）を新版へ上げる手順:

1. サーバを止め、新版を配置する。
2. **（必須）** フォント移設パッチを確認モードで流し、報告を確かめて `-Apply`。構築済み環境では、フォント・js の移設（`assets` → `css\fonts`・`js`、CSS の `url(../fonts/…)` の書き換え、appconfig の `paths.assetsDir` の置き換え）と、appconfig の旧構成の片付け（6.2）の両方が動く。環境変数 `ASSETS_DIR` を設定していた場合は手で外す（パッチは環境変数を変えない）。
3. 画像の置き場パッチを確認モードで流し、`-Apply`（`.gitignore` に `/images/` を足し、`images` を作る）。
4. Python 3.13 が PATH で通っていることを確かめる（新しいコマンドプロンプトで `python --version`）。本番の生成器の場所を `PY_GENERATE_SCRIPT`、指紋を `PY_GENERATE_SCRIPT_SHA256` に設定する。
5. 新しいコマンドプロンプトから起動し、起動ログの警告（版・指紋・偽物のまま）が出ていないことを確かめる。フォントを使うテンプレで PDF を出し、フォントと JS が効いていることを確かめる。

6.3 で assets の起動時検査を外すため、手順 2 を飛ばして起動しても止まらず、フォントと JS が欠けた PDF が成功扱いで出る。ユーザーはこのリスクを了承済み（2026-10-02）。手順書とパッチ適用の手順ページでは、手順 2 を必須として目立たせる。

パッチ適用の手順ページ（公開済み）にも、この更新手順を載せる。

### 6.6 細部

- 起動コマンドの既定の引数が空になるので、「bin を明示したら引数の既定は空」の規則（`resolvePythonCommand` の `explicitBin`）は削って単純にする。appconfig の `python.args` で引数を足せる点は残す。
- offline の確認関数の名前は、`py` を前提にしない名前（例: `Test-Python313OnPath`）へ改める。docs のビルド（`docs/_build/build_all.bat`）は開発機でだけ動かすので、`py -3.13` のまま変えない。確認関数のコメントからは docs ビルドへの言及を外す。
- 前回見送った 2 件は解消する。`python-wheelhouse.ps1` は `python -m pip` で、既定（PATH 上の python）と揃う。`LOCALAPPDATA` の件は、py ランチャを使わなくなるので対象外になる。download 側は配布担当の開発機で動くが、開発機も PATH 上の python が 3.13 であることを確認済み（6.7.5）。

### 6.7 点検（2026-10-02）を受けた補強

dataRoot の構成は、ユーザーが手で差し替える予定。パッチはその結果を検査し、問題があれば置き換える（直す）。この前提で穴を点検し、次を足す。

#### 6.7.1 手作業による未コミットの変更（ユーザー判断: 既知の形だけ取り込む）

- フォント移設パッチと画像の置き場パッチは、dataRoot の git に未コミットの変更があると中止していた。手作業の直後は必ずこれに当たる。
- 変更を 1 件ずつ点検し、**パッチ自身が作るのと同じ変更**だけなら取り込んで、パッチの system コミットに含める。
  - CSS の `url(../fonts/…)` → `url(fonts/…)` の書き換えだけの差分
  - `.gitignore` に必須の行（`/css/fonts/`・`/images/` など、`init-data-repo.ps1` が書く行）を足しただけの差分
  - `.gitattributes` を正しい行（`* text eol=lf`）にしただけの差分
  - 追跡していないフォルダの新規作成（中身が無い、または追跡しない置き場だけのもの）
- それ以外の差分が 1 つでもあれば、一覧を出して中止する。中止メッセージは「前回のパッチが途中で止まった」場合と「手作業の変更が残っている」場合を分けて案内する。
- `git init` した直後で HEAD が無い data リポジトリは、「履歴が無い」として扱い、初回コミットの作り方（`init-data-repo.bat`）を案内して中止する。

#### 6.7.2 追跡済みのフォント・画像・js（ユーザー判断: 自動で追跡を外す）

- 点検に `git ls-files -- css/fonts images js assets` を足す。追跡されていれば、確認モードで一覧を出し、`-Apply` で `git rm -r --cached`（ファイル自体は残す）して同じ system コミットに含める。
- `init-data-repo.ps1` の初回コミットの `git add -A` を、サーバの承認コミットと同じ確定領域（`templates`・`filled`・`css`（`css/fonts` を除く）・`sync`・`.gitignore`・`.gitattributes`）だけに絞る。手で作り直した dataRoot に `assets`・`js`・`images` が残っていても、初回コミットへ入らないようにするため。

#### 6.7.3 旧構成の残りを起動ログで警告する（ユーザー判断: 止めずに警告）

- 6.3 で外す起動時検査の代わりに、サーバの起動時に次を**警告だけ**する（起動は止めない。生成器の確認と同じ方針）。
  - `<dataRoot>\assets` が残っている
  - `cssDir` の CSS に `url(../fonts/` が残っている
- 警告文には「フォント移設パッチを流してください」と案内を入れる。

#### 6.7.4 パッチの細部

- **元に戻す:** フォント移設の `rollback.ps1` は `assets.migrated-*` が無い環境（手で `assets` を消した、appconfig の片付けだけが動いた）でも止まらず、revert と appconfig の復元だけを行う。戻す日付は `appconfig.json.bak-*` からも決められるようにする。
- **appconfig のバックアップ:** appconfig を 1 か所でも変えるなら必ず `appconfig.json.bak-<日付>` を作る。同じ日に流し直したときは、既存のバックアップを上書きしない（別名で残す）。
- **`python.bin` / `python.args` の外し方:**

  | 今の値（bin, args） | 扱い |
  |---|---|
  | (`python`, 無し) | 両方外す（新しい既定と同じ） |
  | (`py`, `["-3.13"]`) | 両方外す（PATH 上の python へ移る） |
  | (`python`, `["-3.13"]`) | 両方外す（元から起動できない組） |
  | それ以外（絶対パス・他の引数） | 触らずに報告する |

- **`python.script`:** 旧い仮の生成器（`server/scripts/generate_template.py`）を指していれば外す。現行の偽の生成器（`fake_generate_template.py`）を指している場合は既定と同じなので外す。どちらも「本番の生成器は `PY_GENERATE_SCRIPT` で指す」と案内する。
- **editor のフォルダの中の判定:** appconfig の値を `Resolve-EditorPath` で絶対パスにし、`<editorDir>\` で始まるか（大文字小文字を区別しない）で決める。`paths.dataRoot` 自体が editor の中を指す場合も外す。環境変数（`TEMPLATES_DIR`・`CSS_DIR`・`PENDING_DIR` など）が editor の中を指す場合は、パッチは環境変数を変えないので報告だけする。
- **dataRoot の取り違え:** 旧い構成（`assets`）も新しい構成（`css\fonts`）も `[fonts-to-css]` コミットも見つからなければ、「旧構成も新構成も見つからない」と警告し、終了コードを 0 以外にする。
- **置き場違いの報告:** `<dataRoot>\fonts`、`css` 直下のフォント（`.woff2`・`.woff`・`.ttf`・`.otf`）、`assets.migrated-*` 以外の `assets*` を報告する（配信されないため）。中身の違う同名ファイル（競合）は、最初の 1 件で止めずに全件を報告してから中止する。
- **足りないフォルダ:** 更新手順（6.5）に `init-data-repo.bat` を入れる（冪等で、`.git` があれば git を触らない）。6.7.2 の絞り込みを入れた後に限る。
- **git の場所:** パッチは環境変数 `GIT_BIN` があればそれを使う（サーバと同じ）。PortableGit だけの端末で、PATH に git が無くても流せるようにする。
- **旧形式データの報告:** フォント移設パッチの確認モードで、`notes/*.json` に配列でない値（旧形式メモ）、`reviews/*/meta.json` の `status: held`、`filled` フォルダの有無を報告する。6.4 で互換処理を外すので、見つかったら手で直す必要があることを案内する。

#### 6.7.5 Python の PATH（ユーザー判断: 本番機・開発機とも、ユーザー環境変数 PATH で通す）

- 本番環境では、運用者がユーザー環境変数 PATH に Python 3.13 を設定する（手作業）。PATH を書き換える仕組みは作らない。
- 開発機も同じ形にそろえる。この端末は確認済みで、ユーザー環境変数 PATH の先頭に `C:\Users\caads\AppData\Local\Programs\Python\Python313\` と `…\Scripts\` があり、Microsoft Store の偽物（`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`）より先に解決される（`where python` の 1 件目が本物、`python --version` が 3.13.15。2026-10-02）。
- したがって開発機の e2e と `start.bat dev` は、裸の `python` で偽の生成器を動かせる。`e2e-rest-server.ts` の「Windows は既定に任せる」コメントは、PATH 上の python を前提にした文言へ直す。
- 運用手順書に、PATH の設定方法と落とし穴を書く。
  - Python 3.13 のフォルダと `Scripts` を、ユーザー環境変数 PATH の **WindowsApps より前** に置く（インストーラの「Add python.exe to PATH」はこの形になる）。または「アプリ実行エイリアス」の python を切る。
  - `setx` は 1024 文字で切れるので使わず、「環境変数を編集」の画面で設定する。
  - 設定後は新しいコマンドプロンプトで `python --version` が 3.13 になることを確かめ、サーバも新しいコマンドプロンプトから起動し直す。
  - サーバをサービスや別アカウントで動かす場合は、そのアカウントの PATH が使われる。
- 設定を誤ったときは、サーバの起動時の確認（版違い・起動できない）と offline の setup の確認が警告する（3.1・6.1）。

#### 6.7.6 その他

- **offline の確認:** 版の文字列を標準出力から読む（`Get-NativeExitCode` は出力を捨てるので、版を返す別の関数を足す）。関数名の変更に合わせて Pester のテストも直す。
- **互換処理を外す範囲（6.4 の補足）:** `editor/shared/src/schemas.ts` の説明文と、そこから生成する `openapi.json`（再生成する）、`notes.entryId.test.ts`・`notesFile.thread.test.ts`・`noteRepo.test.ts`・`reviews.test.ts`・`localReviewRepo.dom.test.ts`・`auth.store.dom.test.ts` の該当箇所、`stores/auth.ts`、`lib/storageKeys.ts` の旧キー定数も対象。外した後に旧形式が現れたときの挙動は、notes は配列でない値を読み捨て、reviews の `held` は 1 件ずつ読み飛ばして一覧全体は落とさない。
- **文書の更新先（6.3 と 6.5 の補足）:** 設計正典（`docs/editor/src/設計正典.md` の起動中止の記述）と、その要約 `.claude/rules/design-canon-summary.md`（`pnpm run check:canon-summary -- --update`）、設計書、OFFLINE.md、運用手順書、2 本のパッチの README。運用手順書には「`paths.assetsDir` は不明なキーとして読み込みエラーになる／環境変数 `ASSETS_DIR` は無視される」を分けて書く。PATH の落とし穴（偽物より先に本物、`setx` の 1024 文字、別アカウント）も書く。
- **構築済み環境の正確な断面（ユーザー確認 2026-10-02）:** 2026-09-11 より後。したがって `filled` の置き場（09-11 導入）・Undo の保存形式 v2（09-10）・保留の撤去（09-03）・メモの新形式（09-02）はすべて入っており、6.4 の 3 つの互換処理はどれも構築済み環境では使われない。3 つとも外す。

### 6.8 前提の洗い出し（dig、2026-10-02）で決めたこと

ユーザー確認:

- 構築済み環境の `appconfig.json` に、editor のフォルダの中を指す置き場の設定（旧例の `data/templates` など）は入っていない。6.2 の「中断せず外す」はそのままとし、安全弁は足さない。
- 本物の生成器は、PATH 上の Python 3.13 の標準ライブラリだけで動く。外部パッケージや専用の Python の扱いは、入出力の約束（契約）を作り直すときに扱う（範囲外）。

コードで確かめて決めたこと:

1. **HEAD の無い data リポジトリ:** `init-data-repo.ps1` は `.git` があると git を触らないため、6.7.1 の「`init-data-repo.bat` を案内」だけでは初回コミットが作られない。`init-data-repo.ps1` に「`.git` はあるが HEAD が無い」場合の初回コミット（6.7.2 の確定領域への絞り込みと同じ範囲）を足し、パッチはそれを案内する。
2. **`init-data-repo.ps1` も `GIT_BIN` を使う**（2 本のパッチと揃える）。
3. **更新手順（6.5）での `init-data-repo.bat` の位置は、2 本のパッチの後に固定する。** `init-data-repo` は `templates` と `css` を必ず作るので、先に流すと、パッチの取り違えの検査（4. の「`templates` も `css` も無い」）が効かなくなるため（実装時に理由を改めた。2026-10-02）。`init-data-repo` の dataRoot の決め方は、2 本のパッチと同じ順（`-DataRoot` → 環境変数 `DATA_ROOT` → appconfig の `paths.dataRoot` → 既定）にそろえる。
4. **dataRoot の取り違えの検査（6.7.4 を改める）:** 「旧構成も新構成も見つからない」ではなく、**`templates` も `css` も無い** ときに警告し、終了コードを 0 以外にする。フォントを使わない正当な環境（この端末の開発用データなど）を失敗扱いにしないため。
5. **既知の形の差分の判定（6.7.1 の補足）:** BOM と改行コード（CRLF / LF）を除いてから比べる。断面時点の `init-data-repo.ps1` は BOM 付きで書いていたため（開発用データの `.gitattributes` も BOM 付きの `* text=lf`）。
6. **フォントも js も無い `assets` が残っている場合:** フォント移設パッチは、`assets` が残っていれば中身にかかわらず `assets.migrated-<日付>` へ改名する（中身は消さない）。フォントと js 以外のものが入っていれば、報告する。画像の置き場パッチが `assets` の残りで止まり続けないようにするため。
7. **PATH の順序（6.7.5 の補足）:** Windows のプロセスの PATH は「システム PATH の後にユーザー PATH」。システム PATH に別の版の Python があると、ユーザー PATH の先頭に置いても負ける。運用手順書に書き、起動時の版の確認で気づけることも添える。
