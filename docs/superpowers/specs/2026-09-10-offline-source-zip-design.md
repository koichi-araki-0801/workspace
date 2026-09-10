# ネットに出られない端末へソースコードを運ぶ — 設計（Release にソース ZIP を復活させる）

- 日付: 2026-09-10
- 状態: 設計確定（dig 3 ラウンド完了。実装は未着手）
- 前身: `2026-09-06-offline-local-only-design.md`（重量物だけを GitHub Releases に置き、ソースは git clone で受ける形に縮退した設計）。本書はその後継で、縮退時に消した「ソース ZIP の配布」を最小の形で戻す。
- 対象: monorepo（workspace）のみ。python-tools は 2026-09-08 にネット接続前提のセットアップへ移行済みで、本書の対象外（決定 Q10）。

## 0. 背景と目的（日常の言葉で）

2026-09-06 の縮退で「ソースコードは git clone（GitHub から直接コピー）で受け取る」と決めた。ところが、完全にネットに出られない端末（以下「遮断端末」）には git clone の手段がなく、ソースを運ぶ経路が無くなっていた。

そこで、GitHub Releases（配布物の置き場）に **ソース一式を固めた ZIP** を置き直す。ネットに出られる端末（以下「ネット端末」）で ZIP と重量物（依存パッケージなどの大きなファイル群）を取得し、USB などで遮断端末へ持ち込み、遮断端末では **セットアップ用の 1 本のスクリプトだけ** で展開と環境構築を済ませる。

2026-09-10 の作業（`10befc4` / `bb867f0`）で「取得（fetch）」と「展開・構築（setup）」は既に別スクリプトに分けてある。本書はその上に「ソース ZIP」を足す。

## 1. 決定事項（ユーザー確認済み。dig の質問番号 Q1〜Q11 に対応）

| # | 論点 | 決定 |
|---|---|---|
| Q1 | ZIP をいつ上げるか / 重量物との対応をどう担保するか | publish（配布担当が Release を更新するスクリプト）は **作業ツリーが clean（コミットしていない変更が無い）かつ HEAD（今いるコミット）が origin へ push 済み** であることを必須にする。ソース ZIP（`source.zip`）と `source.zip.sha256` は **毎回必ず** 上げる。重量物（`offline-deps-bundle.tar.gz`）は従来どおり content-key（依存の定義ファイル群から計算する指紋）が変わったときだけ上げる。Release は常に最新 1 世代だけを持つ |
| Q2 | 2 回目以降の搬入で古いファイルが残る問題 | setup は展開の前に **前回の名簿（MANIFEST）に載っているファイルを消してから** 展開する。git で管理していないもの（`bk\`・`appconfig.json`・`node_modules`・`docs\_build\vendor`・`pie-chart\out\_baseline` など）は消さない |
| Q3 | fetch がソース ZIP も落とすか | `fetch-offline-bundle.ps1` に `-Source` スイッチを追加する。既定は従来の 3 ファイル、`-Source` を付けたときだけ `source.zip` と `source.zip.sha256` も直下へ置く |
| Q4 | ソース ZIP のすり替え（第三者による差し替え）を検出するか | 検出しない（受容）。README の「受け入れているリスク」に **ソース ZIP も同じ扱い** であることを明記する。縮退で消した pin（別経路で運ぶ照合値）は戻さない |
| Q5 | 名簿（MANIFEST）の作り方と前回の名簿の在処 | publish が `git ls-files`（git が管理しているファイルの一覧）を `MANIFEST` として `git archive --add-file` で ZIP 直下に同梱する。展開後も直下に残し、次回の setup は直下の旧 `MANIFEST` を「消す対象の名簿」として使う。旧 `MANIFEST` が無ければ初回扱いとして警告だけ出して進む |
| Q6 | 遮断端末での展開手順 | 遮断端末で叩くのは `setup-offline.bat` **1 本**。直下に `source.zip` があれば「`.sha256` 照合 → 旧 MANIFEST の名簿を削除 → 展開」まで setup が担う。展開で自分自身（`setup-offline.ps1` と読み込み済みのライブラリ）が新しくなる問題は、**展開後に新しい `setup-offline.ps1` を「展開段を飛ばすフラグ」付きで再実行して構築へ進む** 形で吸収する。初回だけは人が ZIP を手で展開してから setup を実行する（スクリプトが ZIP の中に居るため） |
| Q7 | どのコミットから作った ZIP かの記録 | `SOURCE-COMMIT`（コミット ID と日時の 1 行ファイル）を publish が生成し、`MANIFEST` と同じ `--add-file` で ZIP 直下に同梱する。setup は展開後にそれを表示し、content-key が合わないときの案内に「`source.zip` が古い（publish 忘れ）可能性」を加える |
| Q8 | docs の閲覧用 HTML（8 ファイル 24.4MB。ZIP の約半分）を含めるか | 含める（ZIP は約 21MB）。遮断端末で手引き・設計書をそのまま開ける状態にする |
| Q9 | Release のタグ `offline-bundle-v1` の扱い | タグは動かさない（2026-09-06 の決定を維持）。この端末のローカルのタグ（20df960）はリモート（17e6841）とずれているので `git fetch --tags --force` で揃える。Release 本文に「GitHub が自動で添える Source code は古いので使わない。`source.zip` を使う」と 1 回だけ手で書く |
| Q10 | 遮断端末で python-tools は要るか | 対象外。README-offline に「python-tools は本手順の対象外」と明記する |
| Q11 | 遮断端末側での `source.zip.sha256` の照合 | setup は必ず照合し、`.sha256` が無い・合わないときは中止する（USB 搬送での破損を展開前に止める） |

## 2. 全体像（変更後）

```
配布担当の端末                         ネット端末                     遮断端末
──────────────────────────           ───────────────────────       ──────────────────────────
local-only\offline-publish\           git clone <repo>               （初回）ZIP を手で展開
  publish-offline-bundle              offline\fetch-offline-bundle    3〜5 ファイルを直下へ置く
   ├ clean tree + push 済を確認          -Source                        offline\setup-offline.bat
   ├ git archive HEAD → source.zip     ├ bundle 3 ファイル（従来）       ├ source.zip があれば
   │   + MANIFEST + SOURCE-COMMIT      └ source.zip + .sha256          │   .sha256 照合 → 旧名簿削除 → 展開
   ├ source.zip.sha256                                                 │   → 新しい setup を再実行
   ├ 重量物は content-key 変化時のみ    USB などで持ち込む ──────────▶  ├ 重量物の展開・content-key 照合
   └ gh release upload --clobber                                       └ install / build / git-tools …
          │
          ▼
GitHub Releases offline-bundle-v1（常に最新 1 世代）
  offline-deps-bundle.tar.gz / .sha256 / bundle.key（従来）
  source.zip / source.zip.sha256（本書で追加）
```

- ソースと重量物の対応は従来どおり content-key（`bundle.key`）で確かめる。ZIP のツリーから計算した値と `bundle.key` が違えば setup は止まる。publish が clean tree を必須にするので「ZIP の中身」と「content-key の計算元」が食い違うことは起きない。
- 遮断端末には `.git`（git の履歴フォルダ）が無い。setup はこの状態で動くことを確認済み（必須ファイルは `pnpm-lock.yaml` と `package.json` のみ。content-key の計算は git が無いときファイル走査に切り替わる。`prepare: husky || true` により install も落ちない。`pnpm run ci` の各段も自リポジトリの `.git` を読まない）。

## 3. 変更点

### 3.1 publish（`local-only\offline-publish\publish-offline-bundle.ps1`。git 管理外・配布担当の端末のみ）

| 項目 | 内容 |
|---|---|
| 前提検査の強化 | 既存の「HEAD が origin に在る」に加え、`git status --porcelain` が空（clean tree）でなければ中止する。理由: content-key は作業ツリーから、ZIP は HEAD から作るため、未コミットの変更があると両者がずれる |
| ソース ZIP の生成 | `git archive HEAD --format=zip --add-file=<MANIFEST> --add-file=<SOURCE-COMMIT> -o source.zip`。prefix（先頭フォルダ）は付けない（展開先の直下に `offline\setup-offline.bat` が来る形）。`.gitattributes` の改行・BOM 指定は archive に反映されることを実測済み（`.bat` は CRLF、`.ps1` は UTF-8 BOM のまま入る） |
| `MANIFEST` | `git ls-files` の出力（`/` 区切り・1 行 1 パス・LF）。一時ディレクトリに作って `--add-file` で同梱する（ZIP 直下に `MANIFEST` が入る） |
| `SOURCE-COMMIT` | `<40 桁のコミット ID> <コミット日時 ISO 8601>` の 1 行。同じく `--add-file` で同梱 |
| `source.zip.sha256` | 既存の `.sha256` と同じ書式（`<sha256>  source.zip`） |
| upload | `gh release upload <Tag> source.zip source.zip.sha256 --clobber` を **毎回** 実行する。重量物 3 ファイルの upload は従来どおり content-key 変化時だけ。実行順は「重量物（変化時）→ ソース」とし、ソースだけ古い状態を最短にする |
| 要件 | git 2.30 以上（`--add-file`）。配布担当の端末は 2.52 で確認済み。他端末には要求しない |
| 出力 | 完了メッセージに `source.zip` のサイズと `SOURCE-COMMIT` の内容を出す |

### 3.2 fetch（`offline\fetch-offline-bundle.ps1` / `offline\lib\fetch.ps1`。git 管理。ネット端末が実行）

| 項目 | 内容 |
|---|---|
| `-Source` スイッチ | 付けたときだけ `source.zip` と `source.zip.sha256` も取得する。既定（スイッチなし）は従来の 3 ファイル。理由: git clone で運用する端末の直下に 21MB の ZIP を毎回置かない |
| `Save-VerifiedReleaseBundle` | ソース用に同じ流儀（一時ディレクトリで取得 → `.sha256` 照合 → 直下へ移動）を持つ関数を足す（例: `Save-VerifiedReleaseSource`）。`Downloader` の差し替え口は同じ形にしてテストで実ネットワークを使わない |
| 案内文 | 完了時に「遮断端末へ持ち込むのは 5 ファイル（`-Source` 時）」を列挙する |

### 3.3 setup（`offline\setup-offline.ps1`。git 管理。遮断端末が実行）

| 項目 | 内容 |
|---|---|
| 展開段の新設（[0/5]） | 直下に `source.zip` があるときだけ動く。手順: (1) `source.zip.sha256` を `Assert-FileSha256` で照合（無い・合わない → 中止。Q11） (2) 直下の旧 `MANIFEST` を読み、そこに載っているファイルを削除する（無ければ「初回扱い」の警告を出して削除は行わない。Q5） (3) `Expand-Archive` で直下へ展開する（`MANIFEST` と `SOURCE-COMMIT` も直下に置かれる） (4) `source.zip` と `.sha256` を `bk\` へ退避する (5) **新しい `setup-offline.ps1` を `-SkipSourceExtract`（仮称）付きで再実行** し、その終了コードで終わる（Q6） |
| 削除の安全策 | 旧 `MANIFEST` の各行は「リポジトリ直下からの相対パス」としてだけ解釈する。`..` を含む行・絶対パス・`\\` 始まりは拒否して中止する（名簿を細工されてもリポジトリの外へ出ない）。存在しないファイルは無視する。空になったフォルダは消さない（git 管理外の置き場を巻き込まない） |
| 自己上書きの扱い | PowerShell はスクリプトを起動時に全文読み込むため、展開で自分自身が新しくなっても実行中の処理は落ちない。ただし読み込み済みのライブラリ（`content-key.ps1` 等）は旧版のままなので、構築は必ず再実行した新しい setup に任せる。再帰を防ぐため `-SkipSourceExtract` 時は展開段に入らない |
| `SOURCE-COMMIT` の表示 | 展開段の後（再実行側の冒頭）で `[info] source commit: <ID> <日時>` を出す。ファイルが無ければ「clone 運用」とみなして何も出さない |
| content-key 不一致の案内 | 既存の文面に「`source.zip` が古い（依存を変えたのに publish していない、または古い ZIP を持ち込んだ）可能性」を 1 行足す。`SOURCE-COMMIT` があればその ID も並べて出す |
| 初回の手順 | 人が ZIP を手で新しいフォルダへ展開し、重量物 3 ファイルを直下へ置いてから `offline\setup-offline.bat` を実行する。このとき直下に `source.zip` は無いので展開段は動かず、従来の流れになる |
| 変えないもの | 重量物側の流れ（[1/5]〜[5/5]）・`Assert-LocalRepoRoot`・`Find-LocalBundlePair`・`Install-GitTools` の中身 |

### 3.4 文書・Release

| 対象 | 内容 |
|---|---|
| `offline\README-offline.txt` | 「手順（他端末）」を「ネット端末（fetch -Source）」と「遮断端末（初回 / 2 回目以降）」に分けて書き直す。「受け入れているリスク」に「`source.zip` のすり替えも検出しない（重量物と同じ扱い）」を足す（Q4）。「python-tools は本手順の対象外」を書く（Q10）。持ち込むファイル 5 つと、`MANIFEST` / `SOURCE-COMMIT` は消さないことを書く |
| ルート `README.md` | 入口一覧の fetch の行に `-Source` を足す。「最初に覚える 3 コマンド」は変えない |
| `docs\editor\src\デプロイ運用手順書.md` | 「2. オフライン調達・展開」の 2 項目目を、遮断端末の初回 / 更新の手順に合わせる。書き換え後は `py -3.13 docs\_build\build_all.py --project editor` で HTML を作り直す |
| Release `offline-bundle-v1` の本文 | 「GitHub が自動で添える Source code (zip / tar.gz) は古いコミットのもので使わない。ソースは `source.zip` を使う」を手で 1 回書く（スクリプトは Release 本文を触らない。Q9） |
| ローカルの CLAUDE.md（git 管理外） | 変更なし（offline の記述は README-offline が正） |
| この端末のタグ | `git fetch --tags --force` でローカルの `offline-bundle-v1` をリモート（17e6841）に揃える（作業手順。コードの変更ではない） |

### 3.5 Pester（`offline\lib\verify.Tests.ps1`）で固定する項目

展開段と名簿の扱いは、展開・削除の実処理を `offline\lib` の関数に切り出してテストする（setup 本体は呼び出すだけにする。既存の `Save-VerifiedReleaseBundle` と同じ流儀）。

1. **名簿削除**: 旧 `MANIFEST` に載っているファイルだけが消え、載っていないファイル（`bk\`・`appconfig.json`・`node_modules` 相当のダミー）は残る。存在しない行は無視する。空フォルダは消さない。
2. **名簿の安全策**: `..` を含む行・絶対パス・`\\` 始まりの行があれば何も消さずに例外を投げる。
3. **初回扱い**: 旧 `MANIFEST` が無いとき、削除を行わず警告を出して展開へ進む。
4. **`.sha256` 照合**: `source.zip.sha256` が無い / 値が違うとき、削除も展開も行わずに止まる（直下を汚さない）。
5. **fetch の `-Source`**: 付けたときだけ 5 ファイルが直下に置かれ、付けないときは従来の 3 ファイルだけ。ソースの `.sha256` が合わないとき、重量物 3 ファイルも含めて直下に何も置かない（一時ディレクトリを残さない）。
6. **既存の「git 経路とファイル走査経路の content-key が一致する」テスト**: 変更なし。ZIP 展開後（`.git` 無し）の計算がこのテストの守備範囲であることをコメントで明示する。

publish 側（git 管理外）は Pester の対象外。代わりに E2E（3.6）で確かめる。

### 3.6 E2E の実測手順（`C:\Users\Public\offline-verify\`）

前身の spec と同じ場所を使う。検証フォルダの `DATA_ROOT` / `GIT_BIN` は実データを指さないよう上書きする（`offline-verify-env-var-pitfalls` の教訓）。

1. **publish**: この端末で `local-only\offline-publish\publish-offline-bundle.bat` を実行し、`source.zip` / `.sha256` が Release に並ぶこと、重量物は content-key が変わっていなければ skip されることを確認する。未コミットの変更を 1 つ作った状態で実行し、clean tree の検査で止まることも確認する。
2. **fetch**: `workspace-e2e` を git clone し、`offline\fetch-offline-bundle.bat -Source` で 5 ファイルが直下に置かれることを確認する。スイッチ無しでは 3 ファイルだけであることも確認する。
3. **初回（遮断端末相当）**: `.git` の無い新しいフォルダ `workspace-zip-e2e` に `source.zip` を手で展開し、重量物 3 ファイルを直下へ置いて `offline\setup-offline.bat` を完走させる（HTTPS へ出ないことをネット遮断で確認）。`corepack pnpm run ci` が通ることを確認する（clone 直後と同じく、先に pie-chart の基準を 1 回作る）。
4. **更新（2 回目）**: ソースだけ変えたコミット（追跡ファイルの削除と改名を含める）を push → publish → fetch -Source し、`source.zip` と `.sha256` を `workspace-zip-e2e` の直下へ置いて `offline\setup-offline.bat` を実行する。削除・改名したファイルが残っていないこと、`bk\`・`appconfig.json` が残っていること、`SOURCE-COMMIT` が新しい ID になっていること、再実行された setup が構築まで完走することを確認する。
5. **不一致の案内**: 依存を変えたコミットで publish を行わず、古い重量物のまま 4 を実行し、content-key 不一致の案内に「`source.zip` が古い可能性」の文面と `SOURCE-COMMIT` の ID が出ることを確認する。
6. **回帰**: `pnpm run ci:offline`（Pester）と `pnpm run ci` が緑。

## 4. 却下した案と理由（再提案しないこと）

| 案 | 理由 |
|---|---|
| GitHub が自動で添える Source code をタグ移動で最新化して使う（旧実装の方式） | タグを動かす運用は 2026-09-06 に廃止済み。自動 Source code は GitHub 側で作り直されるためバイト列が固定されず、`.sha256` を添えて照合する設計と相性が悪い（2023-01 に実際に checksum が変わった事例がある） |
| git bundle（履歴ごと運ぶ git 専用の 1 ファイル）/ フォルダ丸ごとコピー | ユーザー判断で不採用（dig 開始前） |
| ソース ZIP は重量物と同時（content-key 変化時）だけ上げる | 依存を変えない修正が遮断端末へ届かず、「ソースは push ごと」の要件に反する |
| ソース専用の publish スクリプトを別に作る | 「どちらを走らせたか」で世代がずれる経路が増える。対応検証を両方に置く必要が出る |
| 前回の `source.zip` を `bk\` に温存し、新旧 ZIP の名簿差分で削除する | `bk\` の ZIP が削除の根拠になって消せなくなる。ZIP を 2 本読む分だけテストの面積が増える |
| 名簿を使わず「追跡ファイルの親フォルダ群」を消してから展開する | `pie-chart\out\_baseline`・`docs\_build\vendor\*.js`・`editor\**\appconfig.json` などの git 管理外がフォルダの内側に在り、温存リストの漏れが重量物や基準の消失になる |
| 展開専用の別スクリプト（`apply-offline-source`）を新設する | 遮断端末で叩くものを setup 1 本に保つユーザー判断。`.ps1` を増やさない |
| 展開を常に手動にし、名簿削除だけ setup に置く | 「削除 → 展開」の順序を人間が守る形になり、逆順だと新しいファイルまで消える |
| `export-subst`（`$Format:%H$` を git が置き換える仕組み）で `SOURCE-COMMIT` を作る | git clone では置き換えが起きず壊れたファイルに見える。`.gitattributes` の追記も要る |
| `MANIFEST` の先頭行にコミット ID を書く | 名簿が純粋なパス列挙でなくなり、削除処理が先頭行を特別扱いする必要が出る |
| docs の閲覧用 HTML を ZIP から外して 10.8MB にする | 遮断端末で手引きを開けなくなる。読者が事務員のため、setup 後の再生成を要求できない |
| タグを 1 回だけ動かす / `offline-bundle-v2` を新設する | 前者は「動かさない」決定を覆す。後者は fetch と README の既定タグ変更が要り、得るものが少ない |
| fetch を clone 無しで単体実行できるようにする（lib の dot-source を解く） | `.sha256` 照合の二重実装を避けるために `.ps1` で統一した 2026-09-10 の判断と衝突する |
| pin（照合値を別経路で手渡す仕組み）を戻す | ユーザー判断で戻さない。すり替えの非検出はソースにも延長して受容する（Q4） |

## 5. 残リスク（受容したもの・運用で受けるもの）

- **すり替えは検出しない**（ソース・重量物とも）。`.sha256` は Release と同じ場所にあるので、USB 搬送や通信の破損しか見つけられない。Release を更新できるのはリポジトリ所有者だけで、配布先は同じ所有者の Public リポジトリを前提にする。
- **publish 忘れ**: フックからは何も自動実行しないため、push しても publish を忘れると Release の `source.zip` は古いままになる。遮断端末では「持ち込んだ ZIP が古い」と気づく手段は `SOURCE-COMMIT` の表示だけ（content-key が同じなら setup は止まらない）。
- **`MANIFEST` を人が消した場合**: 次回の更新で古いファイルが残る。setup は「初回扱い」の警告を出すだけで止まらない。
- **自己上書き後の再実行**: 展開段の処理（`.sha256` 照合・削除・展開）は旧版の setup が行う。展開段の仕様を変えるときは「旧版の展開段でも新版の ZIP を展開できる」ことを保つ必要がある（`MANIFEST` の形式・`source.zip` のファイル名を変えない）。
- **`Install-GitTools` の永続設定**: ユーザー PATH と `GIT_BIN` はリポジトリのフォルダを指す。フォルダを変えて展開し直したときは古い場所を指したままになる（更新は同じフォルダで行う運用にする）。
- **配布担当の端末の要件**: `git archive --add-file` は git 2.30 以上が要る（この端末は 2.52）。

## 6. 触らないもの

- `offline\lib\content-key.ps1` / `bundle_common.py` の content-key の計算（Release の `bundle.key` との互換）。
- 重量物側の流れ（`Find-LocalBundlePair` / 展開 / content-key 照合 / install / build / `Install-GitTools` / `bk\` 退避）。
- Release のタグ `offline-bundle-v1` と既存アセット（`--clobber` で差し替えるだけ）。
- `scripts\ci-affected.mjs`・pre-push の仕組み（遮断端末には `.git` が無く、そもそも動かない）。
- python-tools リポジトリ。

## 7. 次工程への引き渡し

brainstorming → writing-plans の順で進める。計画に載せる作業の単位:

1. **lib の関数化 + Pester**（TDD。3.5 の 1〜5）: 名簿削除・ZIP 展開段・fetch の `-Source` を `offline\lib` へ切り出す。
2. **setup の展開段と再実行**（3.3）: `-SkipSourceExtract` の追加、`SOURCE-COMMIT` の表示、不一致の案内文。
3. **fetch の `-Source`**（3.2）。
4. **publish の変更**（3.1。git 管理外なので本ブランチのコミットには入らない。手順として計画に書く）。
5. **文書と Release 本文**（3.4）: README-offline / ルート README / デプロイ運用手順書（HTML 再生成込み）/ Release 本文 / タグの整列。
6. **E2E**（3.6）を最後に通し、実測時間を本書の「状態」に追記する。

コミット前の注意（既存ルール）: `.bat` は CRLF、日本語を含む `.ps1` は UTF-8 BOM。`offline\` の変更は `ci:affected` の offline 領域（Pester）で検査される。
