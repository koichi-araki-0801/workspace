# 2026-10-fund-images パッチ

editor の data リポジトリに、ファンド別画像の置き場 `images` を用意する一度きりのパッチです。
`.gitignore` に `/images/` を足して画像を git の記録対象から外し、`images` フォルダを作ります。

管理者が行う作業です。`.gitignore` などの変更を承認なしで `system` 名義のコミットにします。

構築済み環境を新版へ上げるときの順番は運用手順書の 3.3 節にあります(`2026-10-fonts-to-css` →
このパッチ → `editor\scripts\init-data-repo.bat`)。

## 前提

- `2026-10-fonts-to-css` の移行が済んでいること。`<dataRoot>\assets` が残っている環境では中止し、
  先にそちらを流すよう案内します(`2026-10-fonts-to-css` は `assets` を中身にかかわらず
  `assets.migrated-<日付>` へ改名します)。`2026-10-fonts-to-css` を元に戻して `assets` が戻った環境でも
  同じく中止します(正しい挙動です)。
- editor サーバが停止していること(稼働中なら中止します)。
- dataRoot が git リポジトリで、履歴(最初のコミット)があること。`git init` だけで履歴が無いときは
  中止し、`editor\scripts\init-data-repo.bat` で初回コミット(確定領域だけを記録)を作るよう案内します。
  git が別の理由で失敗したとき(`dubious ownership` など)は、履歴が無いとは言わずに git の出力を
  そのまま表示して中止します。
- 画像の置き場(`IMAGES_DIR` / appconfig の `paths.imagesDir`)が確定領域の内側にないこと
  (内側なら中止します。サーバも同じ条件で起動を止めます)。

## 手順

1. editor サーバを止める。
2. 新版の editor を配置する。
3. `apply.bat` を引数なしで実行し、確認モードで変更内容と点検結果を見る(何も変えません)。
4. `apply.bat -Apply` で実行する。
5. 構築済み環境の更新なら `editor\scripts\init-data-repo.bat` を流す。
6. editor を起動する。

dataRoot は `-DataRoot <path>` で指定できます。相対パスは今いるフォルダを基準に解決します。
省略時はサーバと同じ順(環境変数 `DATA_ROOT`、ユーザー環境変数、appconfig の `paths.dataRoot`、
既定)で決めます。画像の置き場は `IMAGES_DIR`、appconfig の `paths.imagesDir`、`<dataRoot>\images`
の順で決め、出典を表示します。appconfig などの値がパスとして読めないときは、どの設定かを表示して
中止します。稼働確認のポートは `-Port <n>`(既定 24680)で変えられます。git は環境変数 `GIT_BIN`
があればそれを使います(PATH に git が無い端末向け)。

## 何をするか

- `.gitignore` に `/images/` を追記する(画像を置く前に追跡外にする)。行頭に空白のある
  `  /images/` や行末にタブのある `/images/<TAB>` は git が `/images/` として扱わないので、
  あっても追記します。
- `images` フォルダが無ければ作る。
- 追跡されている画像・フォント・js(`css/fonts`・`images`・`js`・`assets`)を git の追跡から外す
  (ファイルは残します。手で変更してステージした状態のものも外します)。
- `.gitignore` の変更・取り込んだ未コミットの変更・追跡の解除を、`system` 名義の 1 コミット
  (件名末尾に `[fund-images]`)にする。

すでに `/images/` がコミット済みで `images` もあり、追跡されている画像・フォント・js も無ければ、
何も変えずに終わります(コミットも作りません)。

## 未コミットの変更

確定領域(`templates` / `filled` / `css` / `sync` / `.gitignore` / `.gitattributes`。`css\fonts` は
除く)に未コミットの変更があると、1 件ずつ点検します。次の形だけなら取り込んで、同じコミットに
含めます(BOM と改行コードの違いは除いて比べます)。

- `.gitignore` に必須の行(`/drafts/` `/reviews/` `/pending/` `/notes/` `/css/fonts/` `/images/`
  `*.tmp-*`)を足しただけ(新版のサーバが承認時に先に足した場合を含む)
- CSS(`css` 直下の `.css`)の `url(../fonts/…)` → `url(fonts/…)` の書き換えだけ(末尾の改行 1 つの
  有無は問いません)
- `.gitattributes` を `* text eol=lf` にしただけ(旧い `* text=lf` を落とし、他の行は残す)
- 中身の無いフォルダの新規作成(git には見えません)

それ以外が 1 つでもあれば一覧を出して中止します(何も変えません)。確定領域の外でステージ済みの
変更(`git add` 済みで未コミットのもの)も、このパッチのコミットに混ざるので同じく中止します
(確認モードでも)。前回のパッチや rollback が途中で止まった形跡(`.git\index.lock`・`REVERT_HEAD`
など)があればその旨を、無ければ「手作業の変更が残っています」と案内します。残すなら先にコミット
してください。要らなければ、ステージ済みのものは `git restore --staged -- <ファイル>` でステージから
外し(`git checkout -- <ファイル>` だけでは新しく足してステージしたファイルが index に残ります)、
`git checkout -- <ファイル>` で戻して(新しく足したファイルは消して)から再実行してください。

## 終了コード

`<dataRoot>\templates` も `<dataRoot>\css` も無いときは、dataRoot の取り違えとして警告し、何も変えずに
終了コード 2 で終わります。

## 報告だけするもの

既に置かれている画像を点検し、次を一覧で表示します。動かしも消しもしません。

- `[subfolder]` `images` 直下以外(サブフォルダ)に置かれたファイル。配信されません。
- `[extension]` 許可外の拡張子(`.svg` `.png` `.jpg` `.jpeg` 以外)。配信されません。
- `[naming]` 命名 `<fund>_<名前>.<拡張子>` に合わないファイル。配信はされますが、約束から外れます。

SVG の中身の検査はサーバが行います(パッチは行いません)。違反した SVG はどの経路でも表示されず、
サーバログに警告(ファイル名と違反の内容)が出ます。

## 画像の置き方と外部ツールへの約束

- 置き場は `<dataRoot>\images\` の直下だけ。サブフォルダは作らない。
- ファイル名は `<fund>_<画像名>.<拡張子>`(例 `510037_logo.svg`)。拡張子は `.svg` `.png` `.jpg` `.jpeg`。
- 書き込みは一時名で書いてから改名する(書きかけを読ませないため)。
- 値入り HTML の参照は確定したパス(`images/510037_logo.svg`)で書き、`{{ fund.code }}` を残さない。
- SVG には `width` と `height` を書く(無いと `<img>` で 300×150 になる)。
- Illustrator は「書き出し(SVG 1.1)」で保存する。「Illustrator の編集機能を保持」で保存した SVG は
  検査で落ちます。

## 元に戻す

`2026-10-fonts-to-css` も元に戻すときは、このパッチの `rollback.bat` を先に流してください(逆の順だと
`.gitignore` の revert が競合します)。

1. editor サーバを止める。
2. `rollback.bat` を引数なしで実行し、確認モードで内容を見る。
3. `rollback.bat -Apply` で実行する。

目印 `[fund-images]` の移行コミットを `git revert` します(すでに revert 済みなら飛ばすので、2 回目
以降は何も変えません)。追跡を外したファイルは revert で再び追跡されます。revert の前に、戻る場所に
あるファイルを `<dataRoot>\.rollback-tmp-<日付>\` へ退避し、revert の後に同じ内容なら退避を消し、
違えば(戻した版と内容が違うもの)退避に残して報告します。同じ日の退避に同じパスのファイルが
既にあれば、何も変えずに中止します。revert が失敗したとき(競合など)は `git revert --abort` で
戻し、退避したファイルも元へ戻してから中止し、git の出力を表示します。

`images` フォルダと中の画像は消しません(別ツールが置いた git 管理外のもので、戻せないため)。
不要なら手で消してください。

新版のサーバは承認時に `.gitignore` へ `/images/` を再び追記します。元に戻すことに意味があるのは、
サーバも旧版へ戻す場合だけです。
