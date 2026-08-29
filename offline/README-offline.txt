==============================================================================
 オフライン環境構築（Windows x64 専用 / gh 不要・スタンドアロン）
==============================================================================

別端末で、最終的にはインターネット／npm レジストリに接続せずに本プロジェクトの
開発環境を構築するための手順です。この offline/ フォルダ一式だけを別端末へ配置し、
offline\setup-offline.bat を実行すれば、ソースコードと重量物の取得・展開・環境構築
までを 1 本で全自動実行します（GitHub CLI も git も不要）。

配布は 2 系統に分かれ、いずれも GitHub から HTTPS だけで取得します。
  (A) ソースコード … タグ ZIP（codeload）。Release のたびに最新コミットへ更新。
  (B) 重量物       … GitHub Releases のアセット（約 1.2GB。git に入れない）。
                     .pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse

■ 重量物の内訳（GitHub Releases: タグ offline-bundle-v1）
  - .pnpm-store/        … 依存パッケージのオフラインストア（content-addressable）
  - pnpm.tgz            … pnpm 11 本体（corepack 用オフライン tarball）
  - ms-playwright/      … Playwright 用 Chromium（E2E テスト用）
  - python-wheelhouse/  … Python 依存の wheel（docs 閲覧 HTML のビルドとテスト用:
                          markdown-it-py / python-frontmatter / PyYAML / pytest）
  - git-tools/          … PortableGit / TortoiseGit（editor のテンプレ版管理に使う git。
                          air-gapped 機に git が無くても動くよう同梱。setup が展開・導入する）
  - docs/_build/vendor/mermaid*.js … docs の Mermaid 描画ランタイム + ELK レイアウト（計 ~4.3MB。
                          git に入れず同梱し setup が vendor へ展開。版は docs/_build/vendor/manifest.txt）
  - native-prebuilds/   … msnodesqlv8 の公式 prebuild（editor REST / pie-chart DB 入力に必要な
                          ネイティブ .node。npm tarball に入らないため同梱し、setup が
                          pnpm install 後に node_modules の .pnpm 実体へ展開する。
                          版は native-prebuilds/manifest.txt。Node 24.x（ABI 137）専用）
  これらは offline-deps-bundle.tar.gz 1 ファイルに固めて Release に置かれます。
  内容（pnpm-lock.yaml / packageManager / 各 requirements.txt / git-tools/manifest.txt /
  docs/_build/vendor/manifest.txt / native-prebuilds/manifest.txt）に変更が無い限り
  再アップロードされません。

  ※ setup（オンライン/完全オフラインとも）は git-tools の PortableGit を
     git-tools\portablegit\ へ自己展開し、ユーザー PATH と環境変数 GIT_BIN を設定する
     （editor サーバはテンプレ確定保存のたびに git でコミットする）。TortoiseGit は
     履歴/diff 閲覧の GUI として msiexec で導入を試みる（管理者権限が要る場合あり・失敗時は手動）。
     editor のテンプレ実体は editor\scripts\init-data-repo.bat で初期化する data リポジトリ
     （ワークスペース外。既定 ..\editor-data）に置かれ、TortoiseGit でそのフォルダを開ける。

  ※ python-wheelhouse の wheel は publish 機の Python マイナー版・プラットフォーム
     （win_amd64 / cpXY）に紐づくバイナリを含む（PyMuPDF / Pillow / brotli）。
     オフラインビルド機は同一マイナー版の Python を使うこと。各 scripts\build.bat は
     python-wheelhouse があれば --no-index でそこから install し、無ければ通常の
     pip install（要ネット）へフォールバックする。

------------------------------------------------------------------------------
■ 前提
------------------------------------------------------------------------------
  - Windows x64（このバンドルはこの端末と同一 OS/アーキ前提）
  - Node.js 24 以降がインストール済み（corepack 同梱）。確認: node -v
  - tar / curl.exe（Windows 10/11 標準。追加インストール不要）
  - PDF 出力には Microsoft Edge を使用（Windows 標準。追加不要）
  - 取得の間だけリポジトリを Public 公開できること（gh を使わないため）

------------------------------------------------------------------------------
■ 手順（取得端末・別端末）
------------------------------------------------------------------------------

0) 【オンライン側・公開元】リポジトリを一時 Public 化
   GitHub → リポジトリ → Settings → 最下部 Danger Zone →
   "Change repository visibility" → Public に変更。
   ★ 手順 2) まで完了したら、必ず Private へ戻すこと（後述の手順 3）。

1) 【取得端末】この offline/ フォルダ一式を配置し、セットアップを実行
     offline\setup-offline.bat
   これだけで以下を全自動実行します:
     - ソース ZIP を **pin された不変コミット**から HTTPS 直取得 → offline\pinned-release.txt
       の sha256 と突き合わせ → 親フォルダ（リポジトリ直下）へ展開
       （実行中の offline/ 自身は上書きしません）
     - 重量物バンドルを HTTPS 直取得 → pin の sha256 と突き合わせ → offline\bundle-signing.pub.xml
       で分離署名(.sig)を検証 → 展開 → lockfile 整合チェック（bundle.key）
       ★ 検証はすべて必須で、失敗・材料の欠落は中止（配信元に並ぶ .sha256 は同じ場所から
         取る値なので判定には使いません）。
     - 同梱 pnpm を corepack 登録 → 依存をオフライン install → build → Playwright 配置
     - ダウンロードしたアーカイブを bk\ へ退避（同名は削除してから移動）
   「[OK] セットアップ完了。」が表示されれば完了です。

   ※ 取得・展開だけ行い環境構築を省きたい場合:
       offline\setup-offline.bat -SkipBuild
   ※ オーナー/リポジトリ/タグを変えたい場合は引数で上書き:
       offline\setup-offline.bat -Owner <owner> -Repo <repo> -Tag <tag>

   ※【取得なし・完全オフライン】重量物を既に入手済みで、ネット接続を一切させずに
     展開＋構築だけ行いたい場合は専用 bat を使う（DL を行わない）:
       offline\setup-offline-local.bat
     前提: offline-deps-bundle.tar.gz（未展開）、もしくは展開済みの
           .pnpm-store / pnpm.tgz / ms-playwright / python-wheelhouse がリポジトリ直下（または bk\）にあること。
           加えて offline-deps-bundle.tar.gz.sig と bundle.key（検証に必須）。
     引数:
       offline\setup-offline-local.bat -SkipBuild          展開のみ（install/build 省略）
       offline\setup-offline-local.bat -InstallTortoiseGit TortoiseGit も導入（昇格 MSI）
     ※ 検証（pin の sha256 / 分離署名 / bundle.key）は必須で、失敗も材料の欠落も中止します。

2) （任意）動作確認
       corepack pnpm run ci      ← CI 相当の一括検査（Biome / typecheck /
                                    coverage / build / E2E をまとめて実行）
   個別に回す場合:
       corepack pnpm typecheck
       corepack pnpm test
       corepack pnpm test:e2e
       corepack pnpm build
   開発サーバ:  corepack pnpm dev

   ※ pnpm run ci は依存導入済み（本手順 1 完了後）を前提に検査だけを実行します。
     pnpm install / playwright install は行いません（オフライン構築側で済ませる）。
     git push 時は .husky/pre-push が自動で pnpm run ci を実行します。

3) 【オンライン側・公開元】リポジトリを Private へ戻す
   手順 0) と同じ Danger Zone から Private に戻してください。

------------------------------------------------------------------------------
■ 重量物・ソースの公開（調達側・オンライン機）
------------------------------------------------------------------------------
  ★ 初回だけ: 署名鍵を作る（公開担当者の端末で 1 回）
       offline\new-bundle-signing-key.bat
     秘密鍵は %USERPROFILE%\.offline-signing\ へ、公開鍵は offline\bundle-signing.pub.xml へ
     出ます。公開鍵はコミットして offline/ ごと配布先へ運びます（配布先はこれだけを真正性の
     根拠にします）。鍵が無いと重量物の公開は失敗します（署名失敗＝公開失敗）。

  コミット毎フック（.husky/post-commit）が自動で行うのは **タグ移動だけ** です（-TagOnly）:
    - ローリングタグ offline-bundle-v1 を最新コミットへ移動（= Release の自動
      Source code が最新ソースに更新される）
    - 重量物の更新が必要（content key に差分）と判った場合は、タグも動かさずに終了します。
      ★ コミットフックから依存解決器（pip download / pnpm install）は決して走らせません:
        コミットに紛れた requirements.txt / lockfile の編集 1 つで外部コードの取得・実行まで
        無人到達するためです。重量物の更新は下の手動実行で行ってください。

  ★ opt-in 方式（2026-07 変更）: フックは公開に使う clone で 1 回だけ
       git config offline.publish true
     を実行した環境でのみ動きます。新規 clone・オフライン運用環境では既定でスキップ
     され、コミット時に skip の 1 行が表示されます（公開担当者が新しい clone へ移った
     ときは上記コマンドを再実行してください。確認: git config --get offline.publish）。

  重量物を更新する（＝手動実行。依存解決器はここでだけ動く）:
       pwsh -File offline\publish-offline-bundle.ps1
     実行後、offline\pinned-release.txt が更新されるので **忘れずにコミット**してください
     （配布先はこの pin のコミット ID とハッシュだけを信頼します）。
  opt-in 済み環境で一時的に無効化したい場合は環境変数 OFFLINE_PUBLISH_SKIP=1 を設定。

  ※ 公開担当者の環境には Claude Code のローカルフック（.claude/hooks/ の
     auto-push / pie-chart-baseline。git 管理外）が別途あり、新規 clone には
     伝播しません（commit 後の自動 push 等はこのローカル設定によるもの）。

------------------------------------------------------------------------------
■ トラブルシュート
------------------------------------------------------------------------------
  - 「lockfile 不整合の可能性」警告 / install が --frozen-lockfile で失敗する
      → ソースとバンドルのタグがズレています。同一タグで取り直してください。
  - ダウンロードが 404 / 認証を要求される
      → リポジトリが Public になっていません。手順 0) を確認してください。
  - corepack が見つからない / pnpm 登録に失敗する
      → Node.js 24+ をインストールしてください（corepack 同梱）。
  - corepack enable を一度実行しておくと、以後は corepack を付けずに
    pnpm コマンドだけで実行できます（管理者権限が必要な場合があります）。
==============================================================================
