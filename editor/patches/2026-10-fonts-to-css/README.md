# 2026-10-fonts-to-css 移行パッチ

editor の data リポジトリで、フォントの置き場を `assets\fonts` から `css\fonts` へ、js の置き場を
`assets\js` から `js` へ移すパッチです。あわせて、CSS 内のフォント参照を `url(../fonts/x.woff2)` から
`url(fonts/x.woff2)` へ書き換え、appconfig に残る旧構成の設定を片付けます。

管理者が行う作業です。確定 CSS などを承認なしで `system` 名義のコミットとして書き換えます。

構築済み環境を新版へ上げるときは、このパッチを**必ず**流します(全体の順番は運用手順書の 3.3 節:
このパッチ → `2026-10-fund-images` → `editor\scripts\init-data-repo.bat`)。新版のサーバは旧構成の
ままでも起動を止めないため、流し忘れるとフォントと JS が欠けた PDF が成功扱いで出ます(起動ログに
`[layout]` の警告は出ます)。

## 前提

- 新版の editor を配置済みであること。
- editor サーバが停止していること(稼働中なら中止します)。
- dataRoot が git リポジトリで、履歴(最初のコミット)があること。`.git` が無いときと、`git init`
  だけで履歴が無いときは中止し、`editor\scripts\init-data-repo.bat` で初回コミット(確定領域だけを
  記録)を作るよう案内します。

## 手順

1. editor サーバを止める。
2. `migrate.bat` を引数なしで実行し、確認モードで変更内容と報告を見る(何も変えません)。
3. `migrate.bat -Apply` で実行する。
4. 報告に HTML や旧い形式のデータが出たら、手で直す(パッチは書き換えません)。
5. 環境変数 `ASSETS_DIR` を設定していたら外す(新版は読みません。パッチは環境変数を変えません)。
   js の置き場を変えていたなら `JS_DIR` に置き換える。
6. 続けて `2026-10-fund-images` を流し、最後に `editor\scripts\init-data-repo.bat` を流す。

dataRoot は `-DataRoot <path>` で指定できます。省略時はサーバと同じ順(環境変数 `DATA_ROOT`、
ユーザー環境変数、appconfig の `paths.dataRoot`、既定)で決めます。drafts・pending・reviews・filled・
css・旧 assets の置き場も、環境変数(`DRAFTS_DIR` など)、appconfig、dataRoot 配下の既定の順に決め、
出典を表示します。appconfig の値が editor のフォルダの中を指すときは、それを無視して既定を使います。
稼働確認のポートは `-Port <n>`(既定 24680)で変えられます。git は環境変数 `GIT_BIN` があればそれを
使います(PATH に git が無い端末向け)。

## 何をするか

- `.gitignore` に `/css/fonts/` を追記する(フォントを承認コミットへ巻き込まないため)。
- 追跡されているフォント・画像・js(`css/fonts`・`images`・`js`・`assets`)を git の追跡から外す
  (ファイルは残します)。
- `assets\fonts` を `css\fonts` へ、`assets\js` を `js` へコピーし、SHA256 で照合する。照合後に
  旧 `assets\` を中身にかかわらず `assets.migrated-<yyyyMMdd>` へ改名して残す(フォントと js 以外の
  ものは移さず、報告します)。旧 assets を `ASSETS_DIR` / `paths.assetsDir` で別の場所に置いていた
  ときは、その場所を同じフォルダの中で `<フォルダ名>.migrated-<yyyyMMdd>` へ改名します。
- `css\*.css`、`drafts\*.css`、`pending\*.css`、`reviews\<id>\body.css` の `url(` 直後の
  `../fonts/` を `fonts/` に直す。
- appconfig を片付ける。
  - editor の外を指す `paths.assetsDir` を `paths.jsDir`(`<dataRoot>\js`)へ置き換える。
  - editor のフォルダの中を指す置き場の設定(`paths.dataRoot`・`templatesDir`・`filledDir`・`cssDir`・
    `jsDir`・`imagesDir`・`draftsDir`・`pendingDir`・`reviewsDir`・`syncDir`・`assetsDir`。旧例の
    `data/templates` など)を外す。`tmpDir`・`logDir`・`webDist` は対象外です。
  - `python.script` が旧い仮の生成器 `server/scripts/generate_template.py` か、偽の生成器
    `server/scripts/fake_generate_template.py` を指していれば外す。本番の生成器は環境変数
    `PY_GENERATE_SCRIPT` で指してください。
  - `python.bin` / `python.args` は次のとおり扱う(bin の無指定は `python`、args の空配列は「無し」と
    みなします)。

    | 今の値(bin, args) | 扱い |
    |---|---|
    | (`python`, 無し) | 両方外す(新しい既定と同じ) |
    | (`py`, `["-3.13"]`) | 両方外す(PATH 上の python へ移る) |
    | (`python`, `["-3.13"]`) | 両方外す(元から起動できない組) |
    | それ以外(絶対パス・他の引数) | 触らずに報告する |

  - 1 か所でも変えるときは、変える前に `appconfig.json.bak-<yyyyMMdd>` を作る。同じ日に流し直した
    ときは既存のバックアップを上書きせず、`-2`・`-3` … を付けて別名で残す。
- 書き換える作業コピー(drafts・pending・reviews の CSS)は git 管理外なので、書き換え前に
  `<dataRoot>\.fonts-to-css-backup-<yyyyMMdd>\` へ退避する(`rollback.bat` の復元元)。
- 確定領域の変更(`.gitignore`・`css`・取り込んだ `.gitattributes`)と追跡の解除を、`system` 名義の
  1 コミット(件名末尾に `[fonts-to-css]`)にまとめる。

再実行しても、すでに済んだ部分は何も変えません。

## 未コミットの変更

確定領域(`templates` / `filled` / `css` / `sync` / `.gitignore` / `.gitattributes`。`css\fonts` は
除く)に未コミットの変更があると、1 件ずつ点検します。次の形だけなら取り込んで、同じコミットに
含めます(BOM と改行コードの違いは除いて比べます)。

- CSS(`css` 直下の `.css`)の `url(../fonts/…)` → `url(fonts/…)` の書き換えだけ
- `.gitignore` に必須の行(`/drafts/` `/reviews/` `/pending/` `/notes/` `/css/fonts/` `/images/`
  `*.tmp-*`)を足しただけ
- `.gitattributes` を `* text eol=lf` にしただけ(旧い `* text=lf` を落とし、他の行は残す)
- 中身の無いフォルダの新規作成(git には見えません)

それ以外が 1 つでもあれば一覧を出して中止します(何も変えません)。点検範囲の外でステージ済みの
変更も、同じく中止の対象です。前回のパッチや rollback が途中で止まった形跡(`.git\index.lock`・
`REVERT_HEAD` など、移行コミットの無い `assets.migrated-*`)があればその旨を、無ければ「手作業の
変更が残っています」と案内します。残すなら先にコミットしてください。要らなければ、ステージ済みの
ものを `git restore --staged -- <ファイル>` でステージから外し、変更したファイルは
`git checkout -- <ファイル>` で戻し、新しく足したファイルは消してから再実行してください。新しく足した
ファイルを `git checkout --` に渡すと、git の知らないファイルとして全体が失敗します。

## 中止・終了コード

- 移動先に中身の違う同名ファイルがある(競合)、同じ日の `assets.migrated-<日付>` が既にある:
  全件を並べてから中止します(確認モードでも)。
- appconfig の置き場の設定や `python.script`、置き場の環境変数の値がパスとして読めない(`|` などを
  含む): どの設定かを示して中止します。
- `<dataRoot>\templates` も `<dataRoot>\css` も無い: dataRoot の取り違えとして警告し、何も変えずに
  終了コード 2 で終わります。

## CSS の書き方

新構成では、フォントは `css/fonts/` 配下で配信されます。CSS からは `css/` 基準の相対パスで
`url(fonts/x.woff2)` と書きます。`fonts/` は小文字で書いてください。

## 報告だけするもの

次は書き換えず、確認モードと適用時に一覧で報告します。

- `templates` / `filled` の HTML 内にある `fonts/` 参照(移行後は配信されません)。
- `url(css/…)` を持つ CSS(新しい規則では `css/css/` として解釈されます)。
- editor のフォルダに残っている `data`(中身は動かさず、消しません)。
- editor のフォルダの中を指す環境変数(`DATA_ROOT`(ユーザー環境変数を含む)・`TEMPLATES_DIR`・
  `CSS_DIR`・`PENDING_DIR` など)。パッチは環境変数を変えず、置き場の解決にはそのまま使います。
  `ASSETS_DIR` が editor の中を指すときは、その場所を旧 assets として移設・改名することも
  報告に書きます。
- 既定と違う `python.bin` / `python.args`(上の表の「それ以外」)。
- 配信されない場所のフォント: `<dataRoot>\fonts`、`css` 直下のフォント(`.woff2` `.woff` `.ttf`
  `.otf`)、`assets.migrated-*` 以外の `assets*`。
- 旧 assets のフォントと js 以外のもの。
- 新版が読まない旧い形式のデータ: `notes\*.json` の配列でない値(旧形式メモ。新版は読み捨てます)と、
  最上位がオブジェクトでない `notes\*.json`(ファイル 1 件として報告)、`reviews\<id>\meta.json` の
  `status: held`(新版は一覧に出しません)、`filled` フォルダが無いこと(`init-data-repo.bat` で
  作れます)。手で直してください。

## 元に戻す

`2026-10-fund-images` も流していた場合は、先にそちらの `rollback.bat` を流してください(逆の順だと
`.gitignore` の revert が競合します。競合したときは `git revert --abort` で戻して安全に中止しますが、
原因が分かりにくくなります)。

1. editor サーバを止める。
2. `rollback.bat` を引数なしで実行し、確認モードで内容を見る。
3. `rollback.bat -Apply` で実行する。

`rollback.bat -Apply` は次の順で戻します。

1. 移行コミットを revert する(すでに revert 済みなら飛ばします)。追跡を外したファイルは再び追跡され
   ます。revert の前に、戻る場所にあるファイルを `<dataRoot>\.rollback-tmp-<日付>\` へ退避し、revert の
   後に同じ内容なら退避を消し、違えば(戻した版と内容が違うもの)退避に残して報告します。退避の
   `<日付>` は戻す移行の日付です(rollback を流した日ではありません。戻す日付が決まらないときだけ
   流した日)。同じ日付の退避に同じパスのファイルが既にあれば、何も変えずに中止します。revert が競合したときは
   `git revert --abort` で戻し、退避したファイルも元へ戻してから中止します。
2. `assets` を戻す。`assets.migrated-<日付>` を `assets` へ改名します。revert が追跡していた `assets`
   を戻したときは、退避名の側にしか無いファイルだけを `assets` へ移し、同じものは消し、違うものは
   退避名の側に残して報告します。
3. 戻した `assets` に同じ内容がある `css\fonts` と `js` のファイルを削除します。旧 assets と内容が
   違うもの(移行後に置いた、または git に記録された版と違う)と、git が追跡しているもの(移行前から
   追跡されていて revert で追跡に戻ったもの)は消さず、一覧で表示して残します。
4. 退避した作業コピー(drafts・pending・reviews の CSS)を戻します。作業コピーを移行後に編集して
   いた場合、その編集は退避時点の内容で上書きされます。
5. appconfig のバックアップ(`appconfig.json.bak-<日付>`。同じ日に複数あれば最初のもの)を戻します。

2 回目以降(移行コミットが revert 済み)は、4 と 5 を行いません(1 回目の後に直した内容を上書き
しないため)。

`rollback.bat` も `migrate.bat` と同じく、appconfig の置き場の設定が editor のフォルダの中を指すときは
無視して dataRoot 配下の既定を使います。1 回目が戻した移行前の appconfig には旧例の `data/css` などが
残っていますが、2 回目の rollback が editor のフォルダの `data` を片付けの対象にすることはありません。

`assets.migrated-*` が無い環境(手で消した、旧 assets が元から無く appconfig の片付けだけが動いた)
でも止まらず、2 の改名を飛ばして残りを行います。3 の削除は `assets` があるとき(revert が追跡して
いた `assets` を戻したときなど)だけ行い、無ければ `css\fonts` と `js` には触りません。戻す日付は
`assets.migrated-<日付>`・`appconfig.json.bak-<日付>`・`.fonts-to-css-backup-<日付>` から決めます。
候補が複数あるときは `-Date <yyyyMMdd>` で指定します。1 つも無ければ移行コミットの revert だけを
行います。戻したあとは旧版の editor を配置して起動してください。

旧 assets を dataRoot の外(`ASSETS_DIR` / `paths.assetsDir` で別の場所)に置いていた環境では、
`rollback.bat` は `assets.migrated-*` を dataRoot の中しか探しません。その場所の改名は手で
元に戻してください。
