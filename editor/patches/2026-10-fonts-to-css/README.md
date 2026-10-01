# 2026-10-fonts-to-css 移行パッチ

editor の data リポジトリで、フォントの置き場を `assets\fonts` から `css\fonts` へ、js の置き場を
`assets\js` から `js` へ移す一度きりのパッチです。あわせて、CSS 内のフォント参照を
`url(../fonts/x.woff2)` から `url(fonts/x.woff2)` へ書き換えます。

管理者が行う作業です。確定 CSS を承認なしで `system` 名義のコミットとして書き換えます。

## 前提

- 新版の editor を配置済みであること。新版は `assetsDir` / `ASSETS_DIR` / `paths.assetsDir` が
  設定されていると起動を拒否するため、パッチで先に設定を移す必要があります。
- editor サーバが停止していること(稼働中なら中止します)。
- dataRoot の確定領域(`css` / `templates` / `filled` / `.gitignore` など)に未コミットの変更が
  ないこと(あれば中止します)。

## 手順

1. editor サーバを止める。
2. `migrate.bat` を引数なしで実行し、確認モードで変更内容を見る(何も変えません)。
3. `migrate.bat -Apply` で実行する。
4. 報告に HTML が出たら、承認経路で `css/fonts/` 参照へ直す(パッチは HTML を書き換えません)。
5. 環境変数 `ASSETS_DIR` を設定していたら、`JS_DIR` へ置き換える(パッチは環境変数を変えません)。
6. editor を起動する。

dataRoot は `-DataRoot <path>` で指定できます。省略時はサーバと同じ順(環境変数 `DATA_ROOT`、
ユーザー環境変数、appconfig の `paths.dataRoot`、既定)で決めます。drafts・pending・reviews・css・旧 assets の
置き場も、環境変数(`DRAFTS_DIR` など)、appconfig、dataRoot 配下の既定の順に決め、出典を表示します。
稼働確認のポートは `-Port <n>`(既定 24680)で変えられます。

## 何をするか

- `.gitignore` に `/css/fonts/` を追記する(フォントを承認コミットへ巻き込まないため)。
- `assets\fonts` を `css\fonts` へ、`assets\js` を `js` へコピーし、SHA256 で照合する。照合後に
  旧 `assets\` を `assets.migrated-<yyyyMMdd>` へ改名して残す。
- `css\*.css`、`drafts\*.css`、`pending\*.css`、`reviews\<id>\body.css` の `url(` 直後の
  `../fonts/` を `fonts/` に直す。
- appconfig の `paths.assetsDir` を `paths.jsDir` へ書き換える(元は `.bak-<日付>` で残す)。
- 書き換える作業コピー(drafts・pending・reviews の CSS)は git 管理外なので、書き換え前に
  `<dataRoot>\.fonts-to-css-backup-<yyyyMMdd>\` へ退避する(`rollback.bat` の復元元)。
- 確定領域の変更を、`system` 名義の 1 コミット(件名末尾に `[fonts-to-css]`)にまとめる。

再実行しても、すでに移ったものは何も変えません。移動先に別内容のファイルがあるときは、競合として
中止します。

## CSS の書き方

新構成では、フォントは `css/fonts/` 配下で配信されます。CSS からは `css/` 基準の相対パスで
`url(fonts/x.woff2)` と書きます。`fonts/` は小文字で書いてください。

## 報告だけするもの

次は書き換えず、確認モードと適用時に一覧で報告します。

- `templates` / `filled` の HTML 内にある `fonts/` 参照(移行後は配信されません)。
- `url(css/…)` を持つ CSS(新しい規則では `css/css/` として解釈されます)。

## 元に戻す

1. editor サーバを止める。
2. `rollback.bat` を引数なしで実行し、確認モードで内容を見る。
3. `rollback.bat -Apply` で実行する。

移行コミットの revert(すでに revert 済みなら飛ばします)、`assets.migrated-*` の `assets` への
改名、退避に同一内容がある `css\fonts` と `js` のファイルの削除、退避した作業コピーの復元、
appconfig のバックアップの復元を行います。移行後に `css\fonts` や `js` へ置いたファイルは消さず、
一覧で表示して残します。作業コピーを移行後に編集していた場合、その編集は退避時点の内容で
上書きされます。revert が競合したときは `git revert --abort` で戻してから中止します。

`assets.migrated-*` が複数あるときは `-Date <yyyyMMdd>` で指定します。戻したあとは旧版の
editor を配置して起動してください。

旧 assets を dataRoot の外(`ASSETS_DIR` / `paths.assetsDir` で別の場所)に置いていた環境では、
`rollback.bat` は `assets.migrated-*` を dataRoot の中しか探しません。その場所の改名は手で
元に戻してください。
