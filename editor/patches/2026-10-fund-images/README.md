# 2026-10-fund-images パッチ

editor の data リポジトリに、ファンド別画像の置き場 `images` を用意する一度きりのパッチです。
`.gitignore` に `/images/` を足して画像を git の記録対象から外し、`images` フォルダを作ります。

管理者が行う作業です。`.gitignore` の変更を承認なしで `system` 名義のコミットにします。

## 前提

- `2026-10-fonts-to-css` の移行が済んでいること。`<dataRoot>\assets` が残っている環境では中止し、
  先にそちらを流すよう案内します。`2026-10-fonts-to-css` を元に戻して `assets` が戻った環境でも
  同じく中止します(正しい挙動です)。
- editor サーバが停止していること(稼働中なら中止します)。
- dataRoot の確定領域(`templates` / `filled` / `css` / `sync` / `.gitignore` / `.gitattributes`。
  `css\fonts` は除く)に未コミットの変更がないこと。ただし `.gitignore` に `/images/` の 1 行が
  足されただけの状態(新版のサーバが承認時に先に足した場合)は中止せず、その差分をコミットします。
- 画像の置き場(`IMAGES_DIR` / appconfig の `paths.imagesDir`)が確定領域の内側にないこと
  (内側なら中止します。サーバも同じ条件で起動を止めます)。

## 手順

1. editor サーバを止める。
2. 新版の editor を配置する。
3. `apply.bat` を引数なしで実行し、確認モードで変更内容と点検結果を見る(何も変えません)。
4. `apply.bat -Apply` で実行する。
5. editor を起動する。

dataRoot は `-DataRoot <path>` で指定できます。省略時はサーバと同じ順(環境変数 `DATA_ROOT`、
ユーザー環境変数、appconfig の `paths.dataRoot`、既定)で決めます。画像の置き場は
`IMAGES_DIR`、appconfig の `paths.imagesDir`、`<dataRoot>\images` の順で決め、出典を表示します。
稼働確認のポートは `-Port <n>`(既定 24680)で変えられます。

## 何をするか

- `.gitignore` に `/images/` を追記する(画像を置く前に追跡外にする)。
- `images` フォルダが無ければ作る。
- `.gitignore` の変更を `system` 名義の 1 コミット(件名末尾に `[fund-images]`)にする。

すでに `/images/` がコミット済みで `images` もあれば、何も変えずに終わります(コミットも作りません)。

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

1. editor サーバを止める。
2. `rollback.bat` を引数なしで実行し、確認モードで内容を見る。
3. `rollback.bat -Apply` で実行する。

目印 `[fund-images]` の移行コミットを `git revert` します(すでに revert 済みなら飛ばします)。
revert が失敗したときは `git revert --abort` で戻してから中止し、git の出力を表示します。

`images` フォルダと中の画像は消しません(別ツールが置いた git 管理外のもので、戻せないため)。
不要なら手で消してください。

新版のサーバは承認時に `.gitignore` へ `/images/` を再び追記します。元に戻すことに意味があるのは、
サーバも旧版へ戻す場合だけです。
