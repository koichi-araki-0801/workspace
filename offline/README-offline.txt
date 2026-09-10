==============================================================================
 オフライン環境構築（Windows x64）
==============================================================================

重量物（依存パッケージ・ブラウザ・wheel・git ツールなど約 1.1GB）は git に入れず、GitHub Releases の
タグ offline-bundle-v1 に offline-deps-bundle.tar.gz として置いてある。ソースコードは git clone で
受け取るのが基本だが、git clone できない遮断端末向けに同じ Release へ source.zip（ソース ZIP）も
毎回置いてある（手順 B）。

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
  - git clone できること（リポジトリは Public）。遮断端末は手順 B の source.zip で代替できる
  - 取得だけは HTTPS で GitHub に出られること（setup は取得しないためネット不要）

------------------------------------------------------------------------------
■ 手順 A: git clone できる端末
------------------------------------------------------------------------------
1) リポジトリを clone する
     git clone https://github.com/koichi-araki-0801/workspace.git
2) 重量物バンドルを取得する（ネット接続端末）
     offline\fetch-offline-bundle.bat
   Release から offline-deps-bundle.tar.gz / .sha256 / bundle.key の 3 ファイルを HTTPS で取得し、
   Release の .sha256 で転送破損を検査してからリポジトリ直下へ置く（gh 不要）。
3) セットアップを実行する（ネット不要）
     offline\setup-offline.bat
   リポジトリ直下（または bk\）にある offline-deps-bundle.tar.gz と bundle.key の組を使って
   次を行う（取得はしない。組が無ければ手順 2 の実行を案内して停止する）:
     - 展開 → bundle.key と手元のソースの content-key を突き合わせる（不一致は中止）
     - 同梱 pnpm を corepack 登録 → 依存をオフライン install → build → Playwright 配置 →
       PortableGit 展開
     - 直下のバンドルを bk\ へ退避
   「[OK] セットアップ完了。」が出れば完了。
   ※ 展開・整合検査だけ行う場合:  offline\setup-offline.bat -SkipBuild
4)（任意）動作確認
     corepack pnpm run ci

------------------------------------------------------------------------------
■ 手順 B: ネットに出られない端末（遮断端末）
------------------------------------------------------------------------------
git clone できない運用端末は、ソースコードも Release から ZIP（source.zip）で持ち込む。

  B-1 準備（ネット接続端末で）
       clone した直下で
         offline\fetch-offline-bundle.bat -Source
       を実行する。直下の 5 ファイル
         offline-deps-bundle.tar.gz / .sha256 / bundle.key / source.zip / source.zip.sha256
       を USB 等で遮断端末へ運ぶ。
  B-2 初回（遮断端末で）
       source.zip を新しいフォルダへ展開する（エクスプローラの「すべて展開」。展開先の直下に
       offline\ が並ぶ）。続けて重量物 3 ファイル（offline-deps-bundle.tar.gz / .sha256 /
       bundle.key）を展開先の直下へ置き、
         offline\setup-offline.bat
       を実行する。setup は直下に source.zip が無いのでそのまま重量物バンドルの展開・構築へ進む。
  B-3 更新（遮断端末で）
       新しい source.zip と source.zip.sha256 を同じフォルダの直下へ置き、
         offline\setup-offline.bat
       を実行する。setup が直下の source.zip を見つけ、.sha256 で照合 → 前の版の MANIFEST に載る
       ファイルを削除 → 展開 → 新しい setup-offline.ps1 を自動で再実行して構築する。重量物は
       content-key が前回と同じであれば取り直さずそのまま使う。
  ※ 直下の MANIFEST / SOURCE-COMMIT は消さない（次回の更新の削除対象の名簿と、いま入っている
     ソースの版の表示に使う）。
  ※ 更新は最初に展開したフォルダで行う（PortableGit の場所などが環境変数に固定されるため、
     別フォルダへ展開し直すと壊れる）。
  ※ python-tools は本手順の対象外（このリポジトリの source.zip には含まれない）。

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
  - source.zip のすり替えも検出しない（重量物と同じ扱い。Release を更新できるのは所有者のみ）。
  - ソースと重量物の整合は content-key（bundle.key）で担保する。

------------------------------------------------------------------------------
■ トラブルシュート
------------------------------------------------------------------------------
  - 「ソースと重量物が対応していません」で止まる
      → 配布担当に publish-offline-bundle.bat の実行を依頼する。または bundle.key に対応する
        コミットへ checkout し直す（遮断端末では source commit に対応する source.zip を取り直す）。
  - setup が「組がありません」で止まる
      → fetch-offline-bundle.bat を先に実行する（setup は取得を肩代わりしない）。
  - [0/5] で止まる
      → source.zip.sha256 を fetch-offline-bundle.bat -Source で取り直す（転送破損の疑い）。
  - content-key 不一致で source commit が古い
      → 配布担当が publish を忘れている可能性がある。配布担当に依頼する。
  - ダウンロードが 404
      → タグ名（-Tag）とリポジトリの公開状態を確認する。
  - corepack が見つからない
      → Node.js 24+ をインストールする。
  - 展開で unlink に失敗する
      → 直下の git-tools\ を削除してから再実行する。
==============================================================================
