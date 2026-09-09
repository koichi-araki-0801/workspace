==============================================================================
 オフライン環境構築（Windows x64）
==============================================================================

重量物（依存パッケージ・ブラウザ・wheel・git ツールなど約 1.1GB）は git に入れず、GitHub Releases の
タグ offline-bundle-v1 に offline-deps-bundle.tar.gz として置いてある。ソースコードは git clone で受け取る。

■ 重量物の内訳（Release のアセット offline-deps-bundle.tar.gz に同梱）
  - .pnpm-store/        … 依存パッケージのオフラインストア
  - pnpm.tgz            … pnpm 本体（corepack 用）
  - ms-playwright/      … Playwright 用 Chromium（E2E テスト用）
  - python-wheelhouse/  … Python 依存の wheel（docs 閲覧 HTML のビルドとテスト用）
  - git-tools/          … PortableGit / TortoiseGit（editor のテンプレ版管理に使う git）
  - docs/_build/vendor/mermaid*.js … docs の Mermaid 描画ランタイム + ELK レイアウト
  - native-prebuilds/   … msnodesqlv8 の公式 prebuild（Node 24.x 専用）
  同じ場所の bundle.key は、そのバンドルがどの pnpm-lock.yaml / requirements / manifest から
  作られたかを示す content-key。setup はこれと手元のソースを突き合わせる。

------------------------------------------------------------------------------
■ 前提
------------------------------------------------------------------------------
  - Windows x64、Node.js 24 以降（corepack 同梱）、tar / curl.exe（Windows 10/11 標準）
  - PDF 出力には Microsoft Edge を使用（Windows 標準）
  - git clone できること（リポジトリは Public）

------------------------------------------------------------------------------
■ 手順（他端末）
------------------------------------------------------------------------------
1) リポジトリを clone する
     git clone https://github.com/koichi-araki-0801/workspace.git
2) セットアップを実行する
     offline\setup-offline.bat
   これだけで次を全自動で行う:
     - リポジトリ直下（または bk\）に offline-deps-bundle.tar.gz と bundle.key があればそれを使い、
       無ければ Release から HTTPS で直取得する（gh 不要）。取得したときは Release の .sha256 で
       転送破損を検査する
     - 展開 → bundle.key と手元のソースの content-key を突き合わせる（不一致は中止）
     - 同梱 pnpm を corepack 登録 → 依存をオフライン install → build → Playwright 配置 →
       PortableGit 展開
     - 取得物を bk\ へ退避
   「[OK] セットアップ完了。」が出れば完了。
   ※ 展開・整合検査だけ行う場合:  offline\setup-offline.bat -SkipBuild
   ※ ネットに出られない端末では、別の端末で Release から offline-deps-bundle.tar.gz と bundle.key を
      落としてリポジトリ直下へ置いてから実行する。
3)（任意）動作確認
     corepack pnpm run ci

------------------------------------------------------------------------------
■ 重量物の更新（配布担当の端末のみ）
------------------------------------------------------------------------------
  生成と Release への upload は git 管理外の local-only\offline-publish\publish-offline-bundle.bat で行う
  （このフォルダは配布担当の端末にだけある）。pnpm-lock.yaml / package.json の packageManager /
  各 requirements.txt / git-tools/manifest.txt / docs/_build/vendor/manifest.txt /
  native-prebuilds/manifest.txt のどれかを変えて push したら、忘れずに実行する。
  実行を忘れると、他端末の setup は content-key 不一致で止まる（黙って古い重量物を使うことはない）。
  コミットフックからは何も自動実行しない。

------------------------------------------------------------------------------
■ 前提と受け入れているリスク
------------------------------------------------------------------------------
  - Release のアセットのすり替えは検出しない。.sha256 は Release と同じ場所にあるので転送破損の
    検知にしか使えない。Release を更新できるのはリポジトリ所有者だけで、配布先は同じ所有者の
    Public リポジトリを clone している前提で受け入れる。
  - ソースと重量物の整合は content-key（bundle.key）で担保する。

------------------------------------------------------------------------------
■ トラブルシュート
------------------------------------------------------------------------------
  - 「ソースと重量物が対応していません」で止まる
      → 配布担当に publish-offline-bundle.bat の実行を依頼する。または bundle.key に対応する
        コミットへ checkout し直す。
  - ダウンロードが 404
      → タグ名（-Tag）とリポジトリの公開状態を確認する。
  - corepack が見つからない
      → Node.js 24+ をインストールする。
  - 展開で unlink に失敗する
      → 直下の git-tools\ を削除してから再実行する。
==============================================================================
