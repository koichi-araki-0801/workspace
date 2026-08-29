# pdf-to-svg + graph-editor の Node.js 非依存リポジトリへの分離 — 設計書

- 日付: 2026-08-27(v3.5: 2026-08-28 第 2 巡レビュー全反映 + Python 一本化方針
  〈新リポ = 全面 / monorepo = 新規のみ・既存 .ps1 は原則温存 / check-comments のみ
  両リポ Python 統一〉+ 端末 Python は 3.13 のみ)
- ステータス: ユーザー承認済み設計(実装計画は別紙 writing-plans で作成)
- 背景調査: /dig 3 ラウンド + 敵対的レビュー 2 巡(計 6 視点)。いずれも実リポジトリ裏取り済み

## 1. 背景と目的

Node.js を導入できる端末数に制約が生じた。pdf-to-svg と graph-editor は実行時・配布
(PyInstaller exe)とも Python + Edge のみで動作するが、開発・CI・E2E は monorepo の
Node 基盤(vitest / Playwright TS / tsc / pnpm)に依存している。

**目的**: 両プロジェクトを monorepo から完全移動し、**Node.js 無しの端末で clone・開発・
テストまで完結する**独立リポジトリを作る。

### 制約の定義(確定)

- 「Node.js 無し」= **資産管理台帳上の導入不可**。pip wheel 内に同梱されるバイナリ
  (playwright-python の driver 内 node.exe)は許容される。
- 対象の開発・保守端末は**手元の物理 PC 系**(VDI / シンクライアントは対象外。
  よって設計正典の VDI 制約〈隔離プロファイル起動のクラッシュ〉は低リスクだが、
  段取り 0 で軽い実機スパイクにより確認する)。
- したがって playwright-python + Edge channel(端末既存の Edge を使用、ブラウザ DL 不要)
  が採用できる。
- **新リポのスクリプトは Python へ寄せる**(ユーザー方針。根拠: チームの主力言語が
  Python であり、保守できる人が最も多い)。技術スタックを Python に
  一本化し、`.ps1` は新規追加しない。既存 PowerShell 資産(check-requirements /
  build-python-venv / build.ps1 / publish・setup)は Python へ移植する。`.bat` は
  「python スクリプトを呼ぶ起動ランチャ」としてのみ残す(ASCII・`chcp 65001`)。

## 2. 決定事項サマリ

| トピック | 決定 |
|---|---|
| 制約の実体 | 開発・保守端末(物理 PC 系)に Node 導入不可(台帳上。pip 同梱バイナリは可) |
| 分離対象 | pdf-to-svg + graph-editor + docs 原稿/ビルダ |
| 形態 | 完全移動(monorepo から削除・独立開発・双方向同期なし) |
| テスト | 全面 Python 移植(pytest + playwright-python / Edge channel。E2E はマーカーで単体と分離) |
| JS 単体の実行方式 | page.evaluate 方式(ES modules は module script、UMD は classic script + global。**対象 JS は静的サーバの URL 経由で読み込む**) |
| JS カバレッジゲート | CDP の V8 カバレッジを行変換して pytest でゲート化。**閾値は新実装で実測 → 再校正して固定**(旧 85% と数値互換なし) |
| typecheck | 対象がテスト TS のみのため、テスト Python 化に伴い廃止 |
| docs | 原稿+ビルダを分離リポへ移動。monorepo には成果 HTML のみ複製(**生成日+正典リポの刻印**入り) |
| 履歴 | 両リポとも **GitHub 上は新規スタート**(force push / 新規初期コミット)。旧コミットの SHA 直指定・refs/pull 経由の残存は許容。旧履歴はローカル git bundle でアーカイブ保全 |
| 新リポ配置 | 同アカウント(koichi-araki-0801) private |
| オフラインバンドル | 同型の新規書き直し(**Python 実装**・rolling tag 相当含む)。署名鍵は新規発行。**公開鍵コミット → 初回 force publish → pin コミット**の順 |
| スクリプト言語 | **Python 第一**(両リポ共通方針)。新リポ: `.ps1` 無し・既存 PS 資産も Python へ移植。monorepo: 新規は Python、**既存 .ps1 は原則温存**(Python 化は個別判断のみ。§8.5) |
| フック | 素 git hooks(core.hooksPath + Python)。**pre-commit / pre-push / post-commit の 3 本**。有効化はセットアップ入口スクリプトが行う |
| Python 版 | **端末の Python は 3.13 系のみ**(monorepo 含む全用途を 3.13 へ。3.13 で全緑確認後に 3.12・3.14 をアンインストール) |
| 依存バージョン | ピンの正典 = requirements.txt の `==` 固定。開発依存は **`dev-requirements.txt`** へ分離(命名は必要条件 — content-key の FS 経路修正も必須。§4.5 v3.6 正誤) |
| Node ライブラリ | monorepo(editor / pie-chart)の依存も安定最新版へ更新(Node 24 系ランタイムは維持) |
| capture スクショ | Edge 自動更新による byte 差分は許容し「再撮影としてコミット」運用を継続 |
| 段取り | monorepo 内で先に Python テスト整備 → 両輪 green(判定コマンド定義済み) → 新リポ作成 → 除去 → 履歴初期化(直後に明示 publish 必須) |

## 3. 新リポジトリ構成

```
<新リポ root>/
├─ README.md            # 開発セットアップ手順(下記入口スクリプト)を含む
├─ setup-dev.bat        # 開発入口ランチャ → scripts/setup_dev.py:
│                       #   venv 作成 → wheelhouse から pip install --no-index
│                       #   → core.hooksPath 設定(フック有効化)まで一括
├─ graph-editor/        # test/ は Python 化。scripts/build.ps1 は build.py へ移植。
├─ pdf-to-svg/          #   package.json・tsconfig・vitest/playwright config・
│                       #   node_modules は持ち込まない
├─ docs/
│  ├─ _build/           # 純 Python ビルダ(複製)。svg2png.py は playwright-python 化。
│  │                    #   build_all.bat の requirements 検査呼び先は
│  │                    #   check-requirements.bat(下記ランチャ)のまま無改修で成立
│  ├─ graph-editor/     # 原稿 + images + 成果 HTML
│  ├─ pdf-to-svg/       # 同上
│  └─ コメント規約.md    # 共通規約(複製。扱いは §6)
├─ scripts/
│  ├─ check-comments.py # mjs 版(実測 298 行・3 ルール族)の Python 移植。
│  │                    #   例外表(旧 BAT_PAIRING_EXCEPTIONS 相当)も引き継ぐ
│  ├─ check-requirements.py/.bat  # PS 版(実体 offline/lib/verify.ps1)の Python 移植
│  ├─ setup_dev.py      # 開発セットアップ実体
│  ├─ lib/build_venv.py # build-python-venv.ps1 の Python 移植(exe ビルド用隔離 venv 構築)
│  └─ hooks/            # core.hooksPath 用 git hooks 実体(pre-commit/pre-push/post-commit)
├─ offline/             # publish/setup を Python で新規書き直し + README-offline 新リポ版(§8)
├─ .github/workflows/   # 保険 CI(§8)
└─ CLAUDE.md            # ローカル専用(git 追跡外)・新設(内容は §8)
```

- **Node 資産は新リポに持ち込まない**: 両プロジェクト直下の package.json /
  tsconfig.json / vitest.config.* / playwright.config.ts / node_modules は
  スナップショット作成時の除外リストで落とす(§9 step3)。
- **PowerShell 資産は Python へ移植する**(ユーザー方針。§1)。対象と規模:
  check-requirements(実体 `offline/lib/verify.ps1` の requirements 検査・小) /
  `build-python-venv.ps1`(隔離 venv 構築 ~100 行) / 両プロジェクトの `build.ps1`
  (PyInstaller 起動) / publish・setup(§8 でどのみち新規書き直し)。`.bat` は
  「python を呼ぶだけの ASCII ランチャ」として名前を維持する(呼び出し側
  〈`build_all.bat` 等〉のパス関係が無改修で成立)。
- トップレベル並置維持により drift 検査 `test_parallel_impl_drift.py` の
  `parents[2] / "pdf-to-svg"` 参照が無修正で生存(pytest 純実装・Node 非依存を確認済み)。
- graph-editor ⇄ pie-chart の leader 幾何規約はリポジトリ越えになる。両リポの設計正典へ
  相互参照を追記し、**幾何仕様を変えるときの手順**(pie-chart 側検証 `batch:diff` は
  monorepo 環境で回す。変更起点がどちらでも両リポの担当環境で 1 往復する)を明記する。

## 4. テスト移植設計(~150 tests → pytest 一本)

### 4.1 対象の全量

| 資産 | 件数 | 移植方式 |
|---|---|---|
| graph-editor vitest 単体 | 75 tests / 6 ファイル | page.evaluate 方式 |
| graph-editor E2E (Playwright TS) | 34 tests / 5 ファイル(capture 5 件含む) | playwright-python |
| pdf-to-svg vitest 単体 | 34 tests / 2 ファイル | page.evaluate 方式 |
| pdf-to-svg E2E (Playwright TS) | 4 tests / 1 ファイル | playwright-python |
| tsc typecheck | graph-editor の test/**/*.ts のみ | 廃止(対象消滅) |

### 4.2 単体テスト(page.evaluate)の方式詳細

- ES modules(`svg-policy.js` / `pie-rules.js` / `utils.js` / pdf-to-svg の `state.js` /
  `geometry.js`)は page 内 `<script type="module">` で読み込む。
- **`leader_geom.cjs` は UMD であり module script では読めない**(21/109 件)。
  classic `<script>` で読み込み global `LeaderGeom` 経由で評価する。
- **対象 JS は必ずテスト用静的サーバの URL 経由で読み込む**(インラインに埋めると
  CDP カバレッジの scriptCoverage.url が空になり §4.3 が成立しない)。
- フィクスチャ(`editor_svg_policy.test.ts` が `node:fs` で読む
  `test/fixtures/pie_font_face.css` の 1 件)は Python 側で読み、evaluate へ引数注入する。
- モジュールシングルトン(`state.test.js` の `S` + `beforeEach(reset)`)は、各ケースの
  evaluate 前に reset 関数を呼んで再現する(ページ再読込はしない)。
- pytest では parametrize 等で **1 vitest ケース = 1 pytest ケース**として個別報告される
  形にする。移植の対応は旧テストのケース列挙と 1:1 対応表
  (`docs/superpowers/plans/` 配下に置く)で管理する。移植単位はファイル単位の
  RED-GREEN(旧テストを仕様とする)。
- **E2E は pytest マーカー(`-m e2e`)で単体と分離**する。`python -m pytest` 既定収集で
  E2E まで走って ci-affected の軽量 stage が肥大するのを防ぐ(単体 = 既定、E2E = 明示)。

### 4.3 JS カバレッジゲートの再実装(セキュリティゲート・喪失させない)

現行 `vitest.config.ts` は `svg-policy.js` と `leader_geom.cjs` を**全指標 85% 閾値**の
coverage 対象に列挙している(「svg-policy が denylist へ退行すると読み込み即実行に戻る」
ことを守る明示的なセキュリティゲート)。pytest 移行後も playwright-python の CDP
セッション(`Profiler.startPreciseCoverage(detailed)`)で V8 カバレッジを取得し、
対象 2 ファイルの閾値判定を pytest に組み込む。ただし:

- V8 生カバレッジは byte-offset range であり、行判定には offset→行変換 + count=0 範囲の
  差し引き + コメント行の母数除外の自前実装(~300 行)が要る。
- **旧 85% と数値互換は無い**(旧値は v8→istanbul 変換後の行母数)。「85 をそのまま移す」の
  ではなく、**新実装で現行テストを流して実測し、その値の直下へ閾値を再校正して固定**する。
  ゲートの目的(退行で数値が急落したら赤)は行 + 関数カバレッジの 2 指標で担保する。

### 4.4 E2E(playwright-python)の方式詳細

- Edge channel を使用。ブラウザ版は端末の Edge 自動更新に従属する。capture(docs 画像
  再撮影)の byte 差分は「再撮影としてコミット」の現行運用を継続して許容(ユーザー決定)。
- 対象端末は物理 PC 系(VDI 非対象)だが、playwright は隔離一時プロファイルで Edge を
  起動する(設計正典が VDI で却下した起動形態と同型)ため、**段取り 0 で実機スパイク**
  (`msedge --user-data-dir=%TEMP%\edgeprobe --no-first-run about:blank` の安定起動 +
  playwright-python の Edge channel 起動 1 発)を確認してから移植に入る。
- playwright-python に `webServer` 設定は無い。サーバ起動・待機・後始末は pytest fixture
  で実装する。graph-editor の静的サーバ `editor_server.mjs`(60 行・静的配信のみ)は
  Python へ置換し、`app.py` の `SECURITY_HEADERS` を直接 import して逐語複製 drift 面を
  解消する(app.py は import 副作用なし・`__main__` ガード済みを確認。pdf-to-svg 側にも
  `app.py` があるため import はエイリアスで衝突回避 — drift テストの既知の罠)。
- `page.route` / `download` / `dialog` / `filechooser` 等、現行 TS E2E の使用機能は
  playwright-python に等価物があることを確認済み。retries / 並列は必要時のみ導入。

### 4.5 二重テスト期間(monorepo 内並走)の組込

- **開発依存の置き場**: playwright-python / pytest 系は両プロジェクトの
  **`dev-requirements.txt`(新設)**に置く。既存 `requirements.txt` は触らない
  (graph-editor の「実行時依存ゼロ・requirements.txt は触らない」明文ポリシーを維持し、
  exe ビルド venv への playwright 混入も防ぐ — `build.ps1` は requirements.txt のみを
  venv へ入れる。**開発インタプリタへの実行時依存の導入は別問題で必要** —
  pdf-to-svg の `test/conftest.py` が `import fitz` するため pytest には PyMuPDF 等も要る)。
  命名は **末尾が `requirements.txt`** であることが必須
  (`requirements-dev.txt` はグロブに乗らず収集・検査から漏れる)。
  **⚠ v3.6 正誤: 命名だけでは不十分**。「`*requirements.txt` グロブ」が真なのは
  git 経路(`git ls-files`)のみで、content-key の **FS フォールバックは完全名一致**
  (`content-key.ps1` の `-Filter 'requirements.txt'`)のため dev-requirements を数えない。
  FS 経路は配布先(zip 展開・.git 無し)の setup が実際に使う経路であり、放置すると
  ①Pester の 2 経路一致検査が赤 → pre-push(`ci:offline`)で push 不能、②公開後に
  配布先 setup が key 不一致の fail closed で全滅する。**FS フォールバックの修正
  (git 経路と同一集合化)を dev-requirements 新設と同一コミットで行う**こと。
- **dev-requirements 追加は content-key を反転させる** → 追加直後に明示 publish を
  1 回行い、二重期間中に rolling tag 更新が止まる副作用を解消する。
- **CI 組込**: 新 pytest 単体は既存の `python -m pytest` 収集(`test:graph-editor:py` /
  `test:pdf-to-svg`)に自動で乗る(編集不要)。E2E は `-m e2e` の明示実行を `ci` へ追加。
  `.github/workflows/ci.yml` は ①pip install に dev-requirements を追加、
  ②`python-version` を **3.13** へ更新、③E2E を走らせる場合は
  `playwright install msedge` を追加(走らせない場合は `-m "not e2e"` を明示)。
- **ポート**: 旧 TS E2E の :5179 と衝突しないよう、Python 置換サーバは別ポートで並走。
- **テストファイル命名**: 両プロジェクトの test/ に同名 .py を置かない
  (pytest の import file mismatch 制約。`test_edge_launch.py` が既に両方に実在)。
  移植ファイルはプロジェクト接頭辞等で衝突回避する。
- **資源**: 実機 8GB で E2E 二重化により CI 時間・メモリが増える。二重期間は最小化し、
  フレーク時は単独 green 確認 → リトライの既存運用に従う。

## 5. 履歴の初期化(両リポ)

### 5.1 目的の定義(確定)

**「新規スタート」であり「完全抹消」ではない**。見える履歴(コミット一覧・PR ページからの
到達)が新しくなればよく、旧コミットが SHA 直指定や refs/pull(61 本現存)経由で GitHub 上に
残存することは許容する。よって force push / 新規初期コミットで実現し、**リポジトリの
削除・再作成はしない**(Release 774MB・設定・PR 記録が全損するため。§11 参照)。

### 5.2 旧履歴のアーカイブ(force push 直前の必須ゲート)

コミットメッセージは設計判断の正典(特にセキュリティ修正 run 1/run 2)のため保全する:

1. **作成タイミングは monorepo 側の全コミット(§7 の除去・依存更新を含む)が終わった後、
   force push の直前**。早く作ると最後のコミット群がアーカイブから漏れる。
2. `git bundle create <保管先>/workspace-history-2026-08.bundle --all` で全ブランチ・
   全タグ・stash ref をアーカイブする。
3. bundle からの clone と `git log` 参照ができることを検証してから初期化へ進む。
4. 保管先はリポジトリ外(オフラインバンドルと同じ保管場所)。
5. **bundle に入らないもの**を worktree 側で保全してから進む:
   - untracked ファイル(現状: `gist1.md` / `gist2.md` / `docs/superpowers/plans/*.md`)
     → コミットするか保管先へコピー。
   - git 管理外の実体(ローカル CLAUDE.md・`.claude/` フック・`docs/_build/vendor` 等)
     → worktree の温存を前提として明記する。
   - **stash**(現在 57 ファイルの WIP・base=4fb40e4) → `git stash show -p` で内容確認し、
     分離対象 2 プロジェクトに触れる hunk は適用先が消えるため破棄、それ以外は適用可否を
     個別判断してから初期化する。

### 5.3 新リポ(分離側)

- 移行完了後のツリー(テスト Python 化・Node 資産除外済み)のスナップショットを
  **初期コミット**として作成し、同アカウント private の新リポへ push する(手順は §9 step3)。

### 5.4 monorepo 側

- 除去(§7)まで完了した時点のツリーを新規初期コミットへ squash し(手技:
  `git checkout --orphan` または `git commit-tree HEAD^{tree}` で無親コミットを作る)、
  `main` を初期コミットに置き、常設ブランチ `chore/deps-latest-offline-bundle` を
  main と同一コミットから作り直して force push する(squash 分岐運用はここを起点に再開)。
- **force push 対象 ref を事前に棚卸しする**: `main` / 常設ブランチ / `offline-bundle-v1`
  タグ(明示 publish で移動) / その他のタグ・ブランチは初期化時に削除するか個別判断。
- **force push 直後に `publish-offline-bundle.ps1` の明示実行を必須ゲートとする**
  (pin の source-commit と rolling tag を新履歴のコミットへ更新する。これを行うまで
  配布済み setup は旧 SHA の archive 取得に依存した不安定状態になる)。検証は
  クリーンな作業ディレクトリで `setup-offline` を実行し新 pin で通ることを確認する
  (現行手順書の「一時 Public 化」運用に従う)。
- post-commit の自動 publish は初期化作業中 `OFFLINE_PUBLISH_SKIP=1` で止め、上記の
  明示 publish に一本化する(SKIP は post-commit のみに効く。pre-push は止まらない)。
- force push はブランチ ref 2 本(main / 常設)で pre-push のフル CI が走る(最大 2 回)。
  `--no-verify` は使わない(全緑を確認してから初期化する手順順序で吸収する)。
- 他端末の既存 clone は初期化後 fetch 不能になる(再 clone 一択)。配布先は zip 展開のみで
  無傷。Z: ドライブ運用の clone があれば再 clone 対象に含める。

## 6. docs の扱い

- **原稿 + ビルダ = 分離リポが正典**。monorepo には閲覧用の成果 HTML のみ複製する。
- **成果 HTML の同期手順**: docs/{graph-editor,pdf-to-svg} を更新したら新リポで
  `build_all.py` を実行し、生成 HTML を monorepo の `docs/<proj>/` へコピーして
  コミットする(手動・低頻度)。**コピー忘れの検知として、生成 HTML に「生成日 + 正典は
  分離リポ」の刻印を入れる**(ビルダのフッタ出力に追加。閲覧者が鮮度と正典を判別できる
  ようにする)。
- **docs/_build と コメント規約.md の複製 drift を許容する理由(原稿の二重管理却下との
  非対称)**: 原稿は「読者へ届く内容」であり発散すると誤った手順書が正典面を持つ実害が
  出る。一方ビルダと規約検査は「各リポ内で完結する道具」で、乖離しても各リポの成果物・
  検査はそのリポ内で一貫して正しく動く。よって原稿は正典一意(却下)、道具は複製許容とする。
  改善を入れた側が他方へ反映する運用ルールを両 CLAUDE.md に明記する。
- 新リポ側 `docs/_build/build_all.bat` は `..\..\scripts\check-requirements.bat` を呼ぶ
  現行実装のまま成立する(check-requirements は Python 移植だが、同名 `.bat` ランチャが
  python 実装を呼ぶため呼び出し側は無改修。§3)。パス関係は移設時に確認する。
- `svg2png.py` の Playwright 依存は分離リポ側で playwright-python 化する。
- monorepo 側は `docs/{graph-editor,pdf-to-svg}/src` 原稿と `images/` を削除し、成果
  HTML のみ残す(HTML は画像を base64 インラインした自己完結ファイルのため images/ は
  不要。`build_all.py` は `docs/<proj>/src/` の**自動検出**なので原稿 dir が消えれば
  対象から外れる)。
- graph-editor のスクリーンショット再撮影(`capture_docs.e2e.ts`)は E2E 移植に含めて
  Python 化する(pdf-to-svg は既に Python の `capture_screens.py`)。

## 7. monorepo 側の除去(チェックリスト・v3 補正済み)

0. **`graph-editor/` と `pdf-to-svg/` のディレクトリ本体を削除する**(移植済み新 pytest・
   dev-requirements.txt もディレクトリごと消える = 二重テスト期間の終了)
1. ルート `package.json`: `test:pdf-to-svg` / `test:graph-editor` / `test:graph-editor:py` /
   `test:pdf-to-svg:js` / `typecheck:graph-editor` / `e2e:{pdf-to-svg,graph-editor}` /
   `ci:{graph-editor,pdf-to-svg}` / `ci` 内の 2 段(+二重期間に足した E2E 段) /
   `typecheck` の `--filter graph-editor`
2. `vitest.config.ts`: projects の graph-editor(pdf-to-svg は projects に**元々無い**) +
   **coverage include の graph-editor 2 行**(`leader_geom.cjs` / `svg-policy.js`)
3. `scripts/ci-affected.mjs`: 領域マップ + BENIGN 除外コメント。**`ci-affected.test.mjs`
   の該当ケースも追随**(`test:scripts` が `ci` に組込済みのため放置すると赤)
4. `scripts/clean.mjs` + `clean.test.mjs` の対象列挙
5. `scripts/check-comments.mjs`: **mjs を廃止し check-comments.py(新リポと同一実装 +
   monorepo 用設定)へ差し替え**(§8。`package.json` の `check:comments` 呼び先変更含む)
6. `pnpm-workspace.yaml`: packages 2 行 + **`knip.json` の graph-editor workspace 定義**
7. `offline/publish-offline-bundle.ps1`: workspace ループ・python-wheelhouse の該当分 +
   **`setup-offline.ps1` / `setup-offline-local.ps1` の展開リストと `README-offline.txt`**
8. `.github/workflows/ci.yml`: pip install 行(除去後は docs/_build 分のみ)・pytest 段の
   対象・ブラウザ install 段
9. CLAUDE.md の `@docs/{graph-editor,pdf-to-svg}/src/設計正典.md` import 2 行(ローカル専用)
10. `docs/{graph-editor,pdf-to-svg}` の src 原稿と images/ の削除 + 成果 HTML の残置(§6)
11. ルート `README.md`(参照 10 箇所: 入口スクリプト一覧・領域別 CI 説明)
12. 残存ドキュメント・コメントの参照修正: `tsconfig.base.json` コメント /
    `.vscode/settings.json`・`launch.json` / `editor/README.md`・`editor/OFFLINE.md` /
    `editor/server/src/app.ts:108`・`config.ts:568`(「同一リポジトリの pdf-to-svg」→
    分離後の実態へ) / `pie-chart/README.md`・`docs/pie-chart/src/設計書.md`・
    `pie-chart/test/output_escaping.test.ts` の言及
13. code-review-graph の graph DB 再構築・MEMORY.md の関連ノート追随

- 削除は常設ブランチ上で行う。**コミットは「除去」と「Node 依存更新(§8.5)」で分割**して
  個別に検証可能にする(重量物バンドルの再生成回数はコミット数でなく**明示 publish の
  回数**で決まるため、同一コミットに束ねる必要は無い。publish は最後に 1 回)。
- check-requirements の検査対象はグロブ走査のためファイル削除に自動追随(編集不要)。

## 8. 新リポジトリ基盤

- **フックは 3 本**(core.hooksPath + Python。有効化は `setup-dev` が `git config
  core.hooksPath` を設定する — pip には postinstall が無いため入口スクリプトに一本化):
  - pre-commit = check-comments.py
  - **pre-push = pytest 集約(単体 + E2E)** — 「ローカル CI が正」の強制点。現行 monorepo の
    pre-push `ci:affected` に相当
  - post-commit = auto-push 相当 + rolling tag 追随(`-TagOnly` 相当。content-key 一致時
    のみタグ移動)
- **check-comments は Python 一本に統一する**(保守一本化。v3.5): 現行 mjs(実測 298 行・
  実質 3 ルール族)を Python 移植し、**monorepo 側も同じ check-comments.py へ差し替えて
  mjs を廃止**する(同じ規約を 2 言語で並行保守する形を作らない)。対象ディレクトリと
  例外表(旧 `BAT_PAIRING_EXCEPTIONS` 相当)は設定として外出しし、両リポは
  **同一実装ファイル + リポ別設定**の複製とする(docs/_build と同じ「道具複製」枠。
  改善を入れた側が他方へ反映)。monorepo 側の差し替えは除去(§7)と同時に行う
  (`check:comments` スクリプトの呼び先変更 + ci.yml。monorepo は Python 3.13 必須化
  済みのため実行環境の追加要件なし)。
- **check-requirements / build-python-venv / 両 build.ps1 は Python へ移植**(§1・§3。
  `.bat` は python を呼ぶ ASCII ランチャとして名前を維持)。
- **オフラインバンドルは同型の新規書き直し・Python 実装**(現行 publish は pnpm-lock
  必須で流用不可。gh CLI・tar・ハッシュは Python から subprocess / hashlib で扱う):
  - content-key の新定義 = **全 `*requirements.txt` + docs/_build/vendor manifest の
    SHA256**。
  - 重量物 = python-wheelhouse(dev-requirements 含む全依存。**`pip download` に
    `--python-version 3.13 --only-binary :all:` を明示** — cp312 混入は content-key で
    検知できないため明示指定が唯一の防御。brotli・greenlet 等 native wheel の cp313
    実在は段取り 0 で確認) + docs/_build/vendor(mermaid/elk)。ブラウザは Edge channel の
    ため不要。**git-tools(PortableGit 等)の同梱も不要** — あれは editor の履歴管理
    (dataRoot の git リポ)用に monorepo バンドルへ同梱している資産で、分離リポとは
    無関係(ユーザー確認済み)。
  - **署名鍵は新リポ専用に新規発行**。署名実装も Python 化する(`cryptography`
    パッケージを dev 依存へ追加。鍵形式は新実装に合わせて刷新してよい — どのみち新規鍵)。
    順序: 鍵ペア生成 → **公開鍵をコミット**(publish は公開鍵が無いと失敗する設計を維持)
    → 初回 force publish → 生成された pin をコミット → setup 検証。
  - **README-offline 新リポ版を作る**(一時 Public 化運用・publish の opt-in 機構・
    配布手順。現行手順書と同じ粒度)。
  - setup 内の `$Repo` 名・展開リストは新リポ構成で書き下ろす。
- **保険 CI(GH Actions)**: `python-version: '3.13'`。単体は常時実行、E2E は
  `playwright install msedge` を入れて実行するか `-m "not e2e"` で除外するかを
  実装時に決める(ubuntu ランナーに Edge は既定で無い)。
- **CLAUDE.md**(ローカル専用・git 追跡外): 設計正典 2 本の import / Git 運用 /
  docs・規約複製の反映ルール(§6) / **スクリプトは Python 第一・`.ps1` 新規追加禁止・
  `.bat` は ASCII ランチャのみ**(旧 BOM ルールは .ps1 廃止に伴い不要化) /
  code-review-graph は導入しない(必要になったら別途判断)を明記。

## 8.5 Python 3.13 標準化と依存の安定化

### 現状(2026-08-27 調査)

- 開発端末: Python 3.12.10(既定)+ 3.14。**3.13 は未導入**。py ランチャ既定は
  `py.ini` の `[defaults] python=3.12`、PATH の `python` も 3.12。
- 依存は全て浮動: `docs/_build/requirements.txt`(無指定)、`pdf-to-svg/requirements.txt`
  (無指定)、`pdf-to-svg/pyproject.toml`(下限指定のみ・requires-python `>=3.10`)、
  `graph-editor/requirements.txt`(pyinstaller `>=6.0`)。

### 方針

- **端末の Python は 3.13 系のみにする**(monorepo 含む全用途)。手順: 3.13 導入 →
  検証中は `py -3.13` 明示で**pytest の**全緑を確認 → **3.12 と 3.14 をアンインストール**
  して 3.13 だけを残す(⚠ v3.6 正誤: 「全緑確認後に撤去」の射程は pytest まで。
  **exe ビルドの 3.13 検証は撤去後にしかできない** — venv 構築は `py -3` 解決で
  撤去前は 3.12/3.14 を掴み、かつ cp313 wheelhouse の生成〈明示 publish〉が先に要る。
  よって順序は「pytest 緑 → publish で cp313 wheelhouse → 撤去 → exe ビルド検証」。
  撤去対象には winget 管理の 3.12/3.14 に加え **pymanager 管理の Python
  〈`AppData\Local\Python\bin` の shim。`py -0` に出ない〉**を含める)。
  素の `python`・`py -3` が一意に 3.13 を指すため py.ini の既定切替は不要になり、
  「3.12 で誤検証」も構造的に起きない。
  ⚠ v3.6 正誤: pytest は `pytest graph-editor pdf-to-svg` の**一括実行をしない**
  (同名テストファイルの import file mismatch で必ず失敗する — ci.yml に明文)。
  検証は常にプロジェクト個別実行(§9 step0 の判定も同様)。
  `requires-python` は `>=3.13` へ更新。
- **ピンの正典 = requirements.txt の `==` 完全固定**(オンラインの pip で最新安定を解決
  して固定)。**開発依存(pytest / playwright 等)は `dev-requirements.txt`(新設・両
  プロジェクト)へ分離**し、既存 requirements.txt のポリシー(graph-editor「実行時依存
  ゼロ」・exe ビルド venv には requirements.txt のみ)を維持する。
  `pdf-to-svg/pyproject.toml` の dependencies は**互換性の下限宣言**として残し、
  requirements の固定値と矛盾しない範囲へ下限を引き上げる。
  役割分担: requirements = 再現性(インストールの正)、pyproject = 互換宣言。
- **monorepo 側 wheelhouse の cp313 化**: 現行 publish の `pip download` に
  `--python-version` は無い。**publish スクリプトへ `--python-version 3.13
  --only-binary :all:` を追加する改修が step0 のタスク**(部分再生成の経路は無いため
  フル再生成 1 回。`.github/workflows/ci.yml` の `python-version` も 3.13 へ更新)。
- **対象は Python 資産の全量**: pdf-to-svg、graph-editor、docs/_build(複製のため
  monorepo 側も同一内容で固定)。`editor/server/scripts/generate_template.py` は
  標準ライブラリのみで影響なし。

### monorepo 側のスクリプト言語方針(v3.2 追加・v3.3 縮小)

- **新規スクリプトは monorepo でも Python 第一**とし、CLAUDE.md の「PowerShell
  スクリプト」節へ方針を追記する(根拠: チームの主力言語が Python)。
- **既存 .ps1(22 ファイル・約 3,200 行)は原則温存**。理由:
  - オフラインバンドル系(~2,150 行)は pnpm 固有部(store・ms-playwright・
    native-prebuilds・git-tools)が本体で、新リポ Python 実装と共通化できる部分は薄い
    (ただし新リポ実装はモジュール分割で書き、将来 monorepo が乗り換えたくなった場合に
    流用できる形にはしておく — 移行の約束はしない)。
  - 例外の一本化 1 件: **check-comments は mjs を廃止して Python 版へ統一**(§8。
    同じ規約の 2 言語並行保守だけは作らない)。
  - セキュリティ硬化済み(pin / 署名 / fail-closed 鎖)・Pester テスト付きの実績コードの
    書き直しは、退行リスクだけがあって機能益が無い。
  - monorepo を触る端末は Node 有りで、PS を避ける動機(Node 無し端末の技術スタック
    単純化)がそもそも効かない。
- **既存 .ps1 の Python 化は個別判断のみ**: そのスクリプトへ大きな機能改修が必要に
  なった時、または新リポの Python 実装と実際に保守を一本化できると確認できた時に限る。
  一括移行フェーズは設けない。
- 段取り 0 の publish 改修(`--python-version 3.13` 追加)も **PS のまま最小差分**で行う。

### Node 24 系ライブラリの安定化(monorepo 側)

- editor / pie-chart の npm 依存も**安定最新版へ更新**する(Node 24 系ランタイムは維持)。
- 更新は `pnpm up` で解決し `pnpm-lock.yaml` に固定。メジャーアップは breaking change を
  個別確認し、`pnpm run ci` 全緑をゲートとする。
- pie-chart は更新後に `npm run batch` → `batch:diff` で **SVG 出力の byte 不変**を確認。
- 重量物再生成は §7 の最後の明示 publish 1 回に束ねる。

## 9. 段取り(実装フェーズの大枠・v3 改訂。各 step 末尾 = 完了判定)

0. **環境準備**(詳細な順序と判定はフェーズ 1 実装計画が正): Python 3.13 導入 →
   依存の `==` 固定(dev-requirements 新設 + **content-key FS フォールバック修正を
   同一コミット**)→ `py -3.13` 明示で既存 pytest を**プロジェクト個別に**全緑確認 →
   publish への `--python-version 3.13` 追加改修 + ci.yml の 3.13 化 →
   **明示 publish で cp313 wheelhouse を再生成** → **3.12・3.14(pymanager 分含む)を
   アンインストール** → exe ビルド検証。
   **Edge スパイク**(隔離プロファイル起動 + playwright-python Edge channel 起動 1 発)。
   → 判定: `py -0` の列挙が 3.13 のみ / `python -V` = 3.13 / pytest 個別 3 発
   (pdf-to-svg / graph-editor / docs/_build)全緑 / 両 `scripts\build.bat` が
   3.13 venv + cp313 wheelhouse で exe 生成まで完走 / スパイクで Edge 窓が安定起動
1. **Python テスト移植**(monorepo 内・ファイル単位 RED-GREEN・1:1 対応表を
   `docs/superpowers/plans/` に置く)。§4.5 の CI 組込(E2E 段追加・ci.yml 更新)・
   命名規則・ポート分離(dev-requirements 追加と明示 publish は**フェーズ 1 実装計画へ
   前倒し済み** — ここで二重に計画しない)。
   → 判定: 対応表の全行が「移植済み」/ 新 pytest 単体 + E2E が単独で全緑
2. **両輪 green の確認**。
   → 判定コマンド: `pnpm run ci && pnpm run e2e:graph-editor && pnpm run e2e:pdf-to-svg`
   (`ci` は新 pytest を内包。旧 TS E2E は `ci` に含まれないため明示実行)。
   CDP カバレッジゲート(§4.3)は実測 → 閾値固定まで完了していること
3. **新リポ作成**: `gh repo create <名前> --private` → スナップショット作成
   (`git archive` またはコピー + 除外リスト: package.json / tsconfig / *.config.* /
   node_modules / out / dist / .venv-build) → README・setup_dev.py・hooks・
   check-comments.py・check-requirements.py・build_venv.py・両 build.py・
   offline 新 publish/setup(Python)を執筆 → **鍵ペア生成 → 公開鍵コミット →
   初回 force publish → pin コミット** → 初期コミット群を push。
   → 判定: 新リポ clone + `setup-dev` だけの環境で `python -m pytest`(単体 + E2E)全緑 /
   `pytest -rs` で drift 検査 8 テストが **SKIPPED でなく PASSED** / 両 exe ビルド完走 /
   `setup-offline` 新リポ版が pin 検証込みで完走
4. **凍結開始 = step3 スナップショット時点**。以後 monorepo 側の graph-editor /
   pdf-to-svg / docs 対象原稿へ触らない(万一触る場合は新リポへ同時反映)。
5. **monorepo 除去**: §7 全 14 項目(項目 0 のディレクトリ削除含む)。
   コミットは「除去」→「Node 依存の安定版更新(§8.5)」の 2 群に分割。
   → 判定: `pnpm run ci` 全緑 / pie-chart `batch:diff` byte 不変 / 除去後の
   `git grep -l "graph-editor\|pdf-to-svg"` が §7-12 の意図済み残存(成果 HTML・
   設計正典の相互参照等)のみ
6. **stash・untracked の処置(§5.2-5) → bundle アーカイブ作成 + 参照検証**(force push 直前)。
   → 判定: bundle から clone して `git log` 参照可 / untracked の保全完了 / stash 空
7. **monorepo 履歴初期化**: orphan 初期コミット作成 → main / 常設ブランチを同一
   コミットへ付け替え → ref 棚卸しに従い force push(作業中 `OFFLINE_PUBLISH_SKIP=1`)
   → **直後に明示 publish(pin 更新 + rolling tag 移動)** → クリーン環境で
   `setup-offline` が新 pin で完走することを確認。
   → 判定: `git ls-remote origin` が新履歴の ref を指す / setup 完走
8. **後始末**: 両リポ設計正典へ相互参照追記・残存参照コメント修正(§7-12 の一覧を
   1 枚の対象表に集約して実施)・MEMORY.md 更新(bundle 保管場所 + 参照コマンド
   `git clone <bundle>` / `git show <sha>`。コミット無しのタスクと明示)。
   → 判定: 対象表の全行が完了

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| ガードテスト移植ミスの実害化 | 旧テストとの 1:1 対応表 + 両輪 green の判定コマンド(段取り 1-2) |
| JS カバレッジゲートの消滅 / 数値誤読 | CDP + 行変換で再実装し、**閾値は実測で再校正**(旧 85% と非互換。§4.3) |
| playwright の隔離プロファイル起動が対象端末で不安定 | 対象は物理 PC 系(確定)+ 段取り 0 の Edge スパイクで先行確認(§4.4) |
| exe ビルド venv への dev 依存混入 | dev-requirements.txt 分離(build.ps1 は requirements.txt のみ install。§4.5) |
| dev 依存が wheelhouse・検査から漏れる | 命名を `dev-requirements.txt` に固定 + **content-key の FS フォールバック修正を同一コミットで実施**(命名だけでは配布先経路が漏れる。§4.5 v3.6 正誤) |
| 3.13 検証のつもりで 3.12 実行 | 3.12 自体を撤去して構造的に解消(撤去前の検証は `py -3.13` 明示。§8.5) |
| cp312 wheel の無言混入 | publish へ `--python-version 3.13` を追加改修(monorepo・新リポ両方。content-key では検知不能) |
| 配布先 setup の pin 死亡ウィンドウ | force push 直後の明示 publish を必須ゲート化(§5.4・段取り 7) |
| bundle が最終コミット群を取りこぼす | bundle 作成を force push 直前へ配置(§5.2・段取り 6) |
| 二重期間中の rolling tag 停止 | dev-requirements 追加直後に明示 publish 1 回(§4.5・段取り 1) |
| フック未有効 clone での品質ゲート欠落 | 有効化を setup-dev に一本化 + pre-push フックで pytest 強制(§8) |
| 成果 HTML の陳腐化(コピー忘れ) | 生成日 + 正典リポの刻印をビルダ出力に追加(§6) |
| MEMORY.md・docs 内のコミット SHA 参照が無効化 | 約 30 箇所・注記方式で足りる(実測)。bundle 参照コマンドを MEMORY.md へ、設計正典の退行事例 2 件に個別脚注 |
| Edge 自動更新による capture 画像差分 | 「再撮影としてコミット」運用の継続を明文化(§4.4) |
| 二重テスト期間の資源溢れフレーク(実機 8GB) | 二重期間の最小化 + 単独 green 確認 → リトライ(§4.5) |
| drift 検査の黙殺 | 同一階層維持 + 段取り 3 で PASSED(非 SKIP)を判定に含める |
| docs/_build・規約複製の drift | 非対称理由を §6 に明文化。反映運用を両 CLAUDE.md に明記 |
| Node 依存更新の退行 | コミット分割(§7)+ `pnpm run ci` 全緑 + pie-chart byte 不変 |
| leader 幾何規約のリポ越え | 相互参照 + 変更時の 2 リポ検証手順を設計正典へ(§3) |

## 11. 検討済み・不採用の代替案

- **one-way mirror(subtree split)**: 品質ゲート無傷で工数最小だが、要件が「Node 無し端末で
  開発・保守」のため不成立(ユーザー確定)。
- **py-mini-racer / dukpy での JS 単体実行**: 対象 JS が ES modules で import 不可。
  バンドルすれば通るがバンドラ = Node で自己矛盾。不成立。
- **GH Actions への Node テスト恒久委任**: ローカル集約 CI が正・Actions は保険という
  オフライン運用思想と矛盾。不採用。
- **docs 原稿の二重管理**: 読者へ届く内容の発散は実害(§6 の非対称理由)。不採用。
- **git filter-repo による履歴移行**: 「新規スタート」決定により不要化。旧履歴の保全は
  bundle アーカイブ(§5.2)が代替する。
- **履歴の完全抹消(リポ削除・再作成)**: 不採用(ユーザー確定)。Release 774MB・リポ設定・
  PR 記録が全損する。refs/pull 経由の旧コミット残存は許容。
- **publish/setup スクリプトの新リポへのフル複製**: 不成立(pnpm-lock 必須で即死)。
  同型思想(fail-closed・pin・署名・rolling tag)を引き継いだ新規書き直しへ(§8)。
- **バンドル署名鍵の流用**: 不採用(ユーザー確定)。リポごとに鍵を独立させ漏えい影響を分離。
- **monorepo オフラインバンドル系の一括 Python 化**: v3.2 で一旦掲げたが撤回(v3.3)。
  pnpm 固有部が本体で共通化の実益が薄く、実績ある fail-closed 実装の書き直しは退行
  リスクだけが残るため過大。monorepo は「新規 Python 第一 + 既存温存・個別判断」に縮小。
- **新リポにおける PowerShell 資産の温存(移設)**: v3 で一旦採用したが撤回(v3.1・ユーザー方針)。
  新リポの技術スタックを Python に一本化するため、check-requirements / verify /
  build-python-venv / build.ps1 / publish・setup は Python へ移植する。`.bat` は
  python を呼ぶ ASCII ランチャのみ残す。
- **既存 requirements.txt への dev 依存追加**: 不採用(v3)。明文ポリシーと衝突し、
  exe ビルド venv へ playwright が混入する。`dev-requirements.txt` 分離が正。
