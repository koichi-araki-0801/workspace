# pie-chart

TypeScript 製の円グラフ SVG レンダラ。`{name, value}` の配列(JSON / Excel / サンプル)を入力に、ラベルと引出線を自動配置した円グラフ SVG を生成する。2〜3 人チームでメンテしやすい粒度にモジュール分割している。
`out/svg_js/` の SVG 出力は 83 サンプルの回帰テスト (`verify/svg.ts`) で検証する。
**レンダリング層は外部ライブラリ依存ゼロ**(D3.js 等は不採用)。Excel 入力のみ `exceljs`、フォント埋込のみ `subset-font` に依存し、それぞれ入力層・フォント層に隔離している。

## セットアップ

```bash
npm install
npm run check   # tsc --noEmit で型チェック
npm run batch   # tsx src/test_batch.ts — 83 サンプル一括生成
npm run verify  # tsx src/verify/svg.ts — 自動検証
```

実行系は環境で使い分ける(従来の `run.bat`/`run.ps1` が Node メジャー版で自動判定していたものを、
ラッパ廃止に伴い手動運用へ移行):

- **開発機(pnpm / Node 24 系)**: リポジトリ直下で `pnpm install`、各コマンドは
  `pnpm --filter pie-chart run <script>`(または `pie-chart/` 内で `pnpm run <script>`)。
- **pnpm の無い旧 Node 20 系の単独環境**: この `pie-chart/` フォルダ内で `npm` を直接叩く。

後者向けに `package.json` の `overrides` で **vite を `^6` に固定**している。vite@8 とその bundler
rolldown は Node `^20.19.0 || >=22.12.0` を要求し Node 20.16 で EBADENGINE になるため、rollup ベースで
engines が `^20.0.0` を許容する vite@6 を引く。pnpm はワークスペース *ルート* の `overrides` しか見ず
member(pie-chart)側の指定を無視するため、開発機は最新 vite@8 のまま。= npm 経路だけが vite@6 へ
切り替わる。vite/vitest はテスト専用で、`cli`/`batch`/`verify`/`build:exe` は tsx・esbuild 経由のため
SVG 出力(`out/_baseline` の byte-diff)には影響しない。

## 使い方

### CLI

CLI は `npm run cli -- <command>`(または直接 `tsx src/cli.ts <command>`)で実行する。

- `npm run cli -- list`
- `npm run cli -- one --sample asset_gbca_pdf_like --output-file out/test.svg`
- `npm run cli -- one --data-file data/example.json --output-file out/test.svg`
- `npm run cli -- one --data-json '[{"name":"A","value":60},{"name":"B","value":40}]' --output-file out/test.svg`
- `npm run cli -- one --xlsx data.xlsx --sheet Sheet1 --range A2:B11 --output-file out/test.svg`
- `npm run cli -- one --fund 0331A --base-date 2026-09-30 --chart-type 資産配分 --db-name usrap --output-file out/test.svg`
- `npm run cli -- db-check --db-name usrap`(DB ドライバを読み込めるか、接続できるかの確認)
- `npm run cli -- batch --output-dir out/svg`
- `npm run cli -- batch --input-dir data --output-dir out/svg`

`one` の入力は `--sample` / `--data-file` / `--data-json` / `--xlsx + --sheet + --range` / `--fund + --base-date + --chart-type`(ストアド)のいずれか(`--output-file` 必須)。`batch` は既定で全サンプル、`--samples a,b,c` で対象を絞れる。`--input-dir` 指定時はそのディレクトリ内の `*.json` を一括処理する。

#### Excel 入力の決まり

- `--range` は 2 列固定(左=name、右=value)。3 列以上 / 1 列はエラー。
- **ヘッダ行は指定しない**(データ行のみ渡す)。先頭行が「区分」「比率」のような文字列だと `Non-numeric value at row N` で落ちる。
- 空行はスキップ、name 空欄や value 数値変換不可は明示エラー。
- 数式セルは結果値、リッチテキスト/ハイパーリンクも展開して取り込む。
- exceljs 依存は `src/input/load.ts` の xlsx 節に隔離(`parseRange` / `loadXlsxItems`)。
- 制御文字など XML に載らない文字を含む name セルは明示エラーになる(切り詰めや除去はしない)。

#### DB(SQL Server)入力の決まり

- 入力はストアド 1 本。`--fund` / `--base-date` / `--chart-type` を**3 つそろえて**指定する
  (1 つでも欠けたらエラー)。呼び出しは `EXEC <ストアド> @ファンドコード=?, @基準日=?, @グラフ種別=?`
  で、値は位置バインド。ストアド名の既定は `dbo.pie_chart_items`(仮置き。env `PIE_DB_PROC` で
  上書きでき、`[schema.]name` の形を検査する。各部分に使えるのは文字(日本語の文字も可)・数字・`_` だけで、先頭は文字か `_`、
  `$` / `#` / 角括弧は受け付けない)。
- 基準日は `YYYY-MM-DD` か `YYYYMMDD`。実在する日付かを検査し、`YYYYMMDD` の文字列で渡す
  (サーバの DATEFORMAT 設定に左右されない)。ファンドコードとグラフ種別は 64 文字まで。
- 結果は**列のある結果セットがちょうど 1 つ**、**先頭 2 列**を name / value とする。件数だけの結果
  (`SET NOCOUNT ON` の無いストアドの INSERT など)は無視する。列のある結果が 2 つ以上・列が 2 列で
  ない・0 行はエラー。
- 取得した結果は samples 形式の JSON で残す。既定は `--output-file` の拡張子を `.json` にした場所で、
  `--save-json <path>` で変えられる。書くのは描画の前なので、描画で失敗しても JSON は残る。
  `--data-file` にこの JSON を渡すと、DB に接続せずに同じ SVG(byte 一致)を描ける。
- 接続は **Windows 統合認証**固定(`Trusted_Connection=yes`)で資格情報は持たない。接続先は
  `--db-server`(既定 env `DB_SERVER` / `localhost`)・`--db-name`(既定 env `DB_NAME`)。
  ODBC ドライバは既定 `ODBC Driver 17 for SQL Server`(env `DB_ODBC_DRIVER`)。Driver 18 は
  `Encrypt` の既定が yes なので、サーバ証明書が自己署名なら `DB_CONN_EXTRA=Encrypt=no;` を足す。
- 前提は「実行するユーザーの Windows アカウントが対象ストアドを実行できること」。権限の付け方は
  DB 管理者が決める。読むだけであることはストアドの中身で担保する。
- 接続文字列に入る値は**許可リストで検証**する(driver は既知名の集合、server は
  `[tcp:]host[\instance][,port]`、database は識別子の文字種、`DB_CONN_EXTRA` は `Encrypt` /
  `TrustServerCertificate` / `ApplicationIntent` / `MultiSubnetFailover` / `Connection Timeout` /
  `Login Timeout` のみ)。無検証だと値の `;` から `FILEDSN=\\host\share\x.dsn` のようなキーワードを
  注入されて統合認証のチャレンジレスポンスが外部ホストへ出る。
- ストアドの実行は既定 60 秒で取り消す(env `PIE_DB_QUERY_TIMEOUT_S`、1〜3600)。
- 失敗したときは、止まった段階を `[db:<段階>]` で表示する(`extract` / `verify` / `load` /
  `connect` / `query` / `child`)。`load` で止まる場合は、AppLocker / WDAC / ウイルス対策ソフトが
  `%TEMP%` の DLL の読み込みを止めている可能性がある。`pie-chart db-check [--db-name <db>]` で
  ストアド無しに切り分けられる。
- 既知の制限: SQL Server のエラーメッセージに含まれる日本語(`THROW N'…'` など)は、ドライバ
  (msnodesqlv8)自身の都合で文字化けする。ストアドのエラーメッセージは英数字で書くか、エラー番号で
  判別する。
- 開発版はネイティブドライバ `msnodesqlv8`(`optionalDependencies`)をその場で読む。未導入でも
  他入力と `tsc` は動く。exe 版はドライバを内蔵する(次節)。
- 実装の置き場: `src/input/db.ts`(接続文字列・呼び出し・結果の判定)、`src/input/sproc.ts`
  (開発版 / exe の振り分けと `db-check`)、`src/input/sprocArgs.ts`(引数の検査)、
  `src/input/savedJson.ts`(JSON)、`src/runtime/nativeDriver.ts` / `dbChild.ts`(exe の
  ドライバの書き出しと子プロセス)。

### exe 配布(Node SEA + 外部参照)

非開発者へ配る実行ファイルを生成する。入口は 2 つで、依存の入れ方が異なる:

- **`scripts/build-exe.bat`(ダブルクリック / 旧 Node20 系の単独環境向け)**: ビルド前に
  コミット済みの `package-lock.json` どおりに **`npm ci --ignore-scripts`** で依存を入れ直してから exe を作る
  (lock を消して `npm install` すると範囲指定の新版を掴み、同梱物の固定値の照合で止まる)。
  事前の手動 install は不要で「このフォルダだけ」で完結する(npm 経路は overrides で vite@6 固定)。
- **`npm run build:exe` / `pnpm run build:exe`(= `node scripts/build-exe.mjs`、開発機向け)**:
  install はせず、既存の `node_modules` でビルドのみ行う。pnpm ワークスペースの依存解決を保つ。

**配布物は 2 点だけ**(`--sign` で署名したときは `pie-chart-codesign.cer` と `SIGNING-INFO.txt` を加えた 4 点。フォルダをコピーせず、`pie-chart.exe` 単体でも動く):

```
dist-exe/
├── pie-chart.exe          — Node SEA 実行体(cli + subset-font + wasm + フォント + DB ドライバを全同梱)
└── OFL-BIZUDPGothic.txt   — 埋込フォントの SIL Open Font License(再配布条件)
```

`--sign` のときは、この 2 点に次の 2 点が加わる。

```
├── pie-chart-codesign.cer — 署名の公開証明書(配布先で信頼登録すると署名が Valid に)
└── SIGNING-INFO.txt       — どの鍵で署名した配布物かの記録(thumbprint / 有効期限)
```

- **実行に要るものはすべて exe の中に入れる**。`subset-font` とその JS 閉包は esbuild で
  バンドルし、`harfbuzzjs/hb-subset.wasm` と `fonts/*.woff2` と OFL 本文は **SEA アセット**
  として埋め込む。出力 SVG は CLI/tsx 版と **byte-identical**(同一の subset-font + 同一 wasm)。
- **exe の隣や上位ディレクトリの `fonts/` `node_modules/` は一切見ない**。これは意図的な
  設計で、外に置いたファイルは署名の外にあり誰でも書き換えられるため、そこから実行時に
  コードを読む経路を残さない(上位ディレクトリへ偽 `subset-font` を置くだけで、別ユーザーが
  起動した exe の中でそのコードが走ってしまう)。SEA 実行時は `src/runtime/seaRuntime.ts` が
  ①builtin 以外のモジュール解決をすべて拒否し、②アセット参照を固定キーの許可リストに限定する。
- **exe 版は失敗しても黙って続行しない**。フォントが読めない・subset が効かないときに
  フルフォントへフォールバックすると、配布物が壊れていること自体が見えなくなるため、
  SEA では例外にして落とす(dev は `out/_baseline` の byte-diff が検知するので従来どおり)。
- 使い方は CLI と同じ: `pie-chart.exe one --sample asset_gbca_pdf_like --output-file t.svg` など。
  `pie-chart.exe license` で埋込フォントの OFL 本文を表示できる。
  DB から作る例: `pie-chart.exe one --fund 0331A --base-date 2026-09-30 --chart-type 資産配分 --db-name usrap --output-file t.svg`。
- ビルド依存は `esbuild` / `postject`(devDependencies)のみ。ビルド中に `npm install` は
  走らないので、**完全オフラインで exe を作れる**。
- **DB ドライバだけは exe の外へ書き出して読む**(唯一の例外)。ネイティブモジュールは実ファイル
  からしか読めないため、ストアド入力と `db-check` のときだけ `%TEMP%\pie-chart-db\<pid>-xxxxxx` へ
  新規作成で書き出し、照合(書き出し直後と読み込み直前の 2 回)してから子プロセスが読み込む。
  フォルダは子の終了後に消し、強制終了で残ったものは次の起動時に消す。
- DB 機能つきの exe は**開発機(pnpm / Node 24)でだけ**作る。ドライバは NAN 製で、ビルドに使った
  Node のメジャー版でしか読めないため、ビルドは実際に dlopen して確かめ、合わなければ止まる。
  `build-exe.bat`(Node20 の単独環境)は DB 機能を外して作る(`--no-db`)。
- ビルドは前提が崩れたら **落ちる**(黙って劣化させない): ①Node < 20.12(SEA アセット非対応)
  ②`scripts/sidecar-pins.json` の `subset-font` 版・wasm SHA256 が実解決値と不一致
  ③バンドル内の `require.resolve('harfbuzzjs/hb-subset.wasm')` が 1 箇所でない
  ④`sidecar-pins.json` の `msnodesqlv8` 版・`sqlserverv8NodeSha256` が実解決値と不一致、または
  ドライバを dlopen できない(DB 機能つきのとき)。
  ②が出たら依存を上げた合図なので、`npm run batch` → `npm run batch:diff` と
  `test/render_hash.test.ts` で埋込フォントのバイトが変わっていないかを必ず確認する。

#### コード署名

**既定は未署名**。`node scripts/build-exe.mjs --sign` のときだけ、`scripts/sign-exe.ps1` が exe を SHA256 署名する。配布先に AppLocker / WDAC の発行者ルールが無ければ署名は要らない。

- **署名の役割は「発行元の表示」と「AppLocker / WDAC の発行者ルール」**であって、配布物の
  完全性検証ではない。完全性は上記の全同梱(実行されるものが 100% 署名の内側)で担保する。
- **署名鍵はビルドが勝手に作らない**。`scripts/new-signing-cert.bat` を **1 回だけ**実行して
  作り、表示された thumbprint を `scripts/signing.local.json`(git 管理外)へ書くか、環境変数
  `PIECHART_SIGN_THUMBPRINT` に設定する。以前は「無ければ作る」実装だったため、ビルドした
  端末の数だけ同名の別ルート証明書ができ、「どの `.cer` を配ったか」が追跡不能になっていた。
- `--sign` を付けた場合、thumbprint が無い・署名に失敗したらビルドも失敗する(署名したつもりの
  配布物が未署名で出ないように)。
- 鍵は `NonExportable`(持ち出し不可)・有効期間 **1 年**・TPM 保管が既定。タイムスタンプを
  付けない構成では**期限切れ = 既配布 exe の署名も無効**になるので、期限の 1 か月前に
  再発行・再署名・再配布する。オンラインの署名端末なら `signing.local.json` の
  `timestampServer` に RFC3161 サーバを書けばタイムスタンプを付けられる。
- **社内 PKI(AD CS)があるならそちらから発行すること。** 企業ルートの下で発行できれば
  配布先での Root 追加登録が不要になり、「1 台の PC が持つ鍵が全端末の信頼アンカーになる」
  構造そのものが消える。自己署名を Root へ入れる手順は最終手段で、鍵の保護と撤去手順
  (旧鍵の棚卸し → 配布物の入れ替え → 配布先ストアから削除 → 必要なら Disallowed 登録 →
  ビルド端末で `Remove-Item Cert:\CurrentUser\My\<旧thumbprint> -DeleteKey`)とセットで運用する。
- `--sign` で署名した配布物では、配布先で署名を Valid にする(SmartScreen を抑止する)には、同梱の `pie-chart-codesign.cer` を
  信頼ストアへ取り込む(**管理者権限が必要**):

  ```bat
  certutil -addstore TrustedPublisher pie-chart-codesign.cer
  rem 自己署名の場合のみ、加えてルートとしての登録が要る(社内 PKI 発行なら不要)
  certutil -addstore Root pie-chart-codesign.cer
  ```

- 署名前に node.exe 由来の既存 Authenticode 署名を `build-exe.mjs` の `stripPeSignature` で
  除去する(postject が壊した署名が残ると署名 API が「有効な Win32 アプリではない」で失敗する)。

#### 配布前チェック(必須)

`scripts/verify-dist.bat` を通してから配る。次の 4 点を機械検査し、1 つでも欠ければ非ゼロ終了する。

1. `dist-exe/` の中身が想定どおり(未署名は 2 点、署名ありは 4 点)であること(= **sidecar が復活していない**ことの検査)
2. 署名ありなら署名と thumbprint が期待値と一致すること、未署名なら NotSigned であること
3. exe を空ディレクトリへ 1 個だけコピーして描画した SVG が、開発版(tsx)の出力と byte 一致すること
4. `pie-chart.exe db-check` が成功し、実行ごとのフォルダが残らないこと(DB 機能を外した exe を配らないため)

### 全件生成 + ビューア

- `npm run batch` — 全 83 サンプルを `out/svg_js/` に出力し、`out/compare.html`(A4 想定・1 ページ 12 件のページ送り)を更新
- `npm run verify` — 生成済み SVG のラベル数・bbox オーバーラップ・円内侵入・引出線交差・viewBox はみ出し・引出線屈曲数を自動検証(引数で対象ディレクトリを指定可。既定は `out/svg_js`)

## ディレクトリ構成

```
pie-chart/
├── package.json
├── tsconfig.json
├── samples.json                — サンプルデータ (83 件・object 形式)
├── fonts/                     — 埋込フォント (BIZ UDPGothic WOFF2 400/700 + OFL ライセンス)
├── src/
│   ├── types.ts                — 共通型 (Item / LayoutItem / Placement / Diagnostics / PieLayoutConfig)
│   ├── config.ts               — createPieLayoutConfig + makeColors
│   ├── input/
│   │   ├── load.ts             — samples / xlsx 入力 + normalizeInputItems / resolveInputData*
│   │   ├── db.ts               — DB(SQL Server)ストアド呼び出しと結果の判定
│   │   ├── sproc.ts            — ストアド入力の入口 (開発版 / exe の振り分け・db-check)
│   │   ├── sprocArgs.ts        — ストアド入力の引数検査 (基準日・ストアド名)
│   │   ├── savedJson.ts        — 取得結果の samples 形式 JSON の保存・読み込み
│   │   └── dbStage.ts          — DB 取得の失敗を段階 (`[db:<段階>]`) 付きで表すエラー型
│   ├── glyph_advance/          — 生成物 (npm run gen:widths)。ウェイト別実 glyph advance 表
│   │   ├── weight_400.ts
│   │   └── weight_700.ts
│   ├── layout/
│   │   ├── diagnostics.ts      — layoutLabels orchestrator (モード判定・マーカー付与)
│   │   │                         (profiles / diagnostics / resolve / flip /
│   │   │                          upper-left render Y / left-stack / placeX を section 構成)
│   │   ├── placement.ts        — `build*Draft` + `finalizePlacement`
│   │   │                         (constants / leader / draft builders / finalize を section 構成)
│   │   └── geometry.ts         — 幾何/測定/ナッジ (副作用なし・SVG 文字列なし)
│   ├── svg_export/             — SVG 出力層 (関心事ごとに分離)
│   │   ├── pipeline.ts         — renderPdfStylePieToSvg orchestrator (カスケード実行・候補選択・fallback)
│   │   ├── mode_passes.ts      — モード特化パス (左列 / top-band クラスタ / 右上逃がし)
│   │   ├── emit_repair.ts      — emit 修復パス列 (EMIT_REPAIR_PASSES) + 採点・do-no-harm ゲート基盤
│   │   ├── leader_geometry.ts  — leader 幾何 (交差・貫通・角度整合の計測)
│   │   │                         ※ python-tools リポジトリ graph-editor の
│   │   │                           resources/web/lib/leader_geom.cjs は意図的な並行実装
│   │   │                           (共通化は禁じ手・あちらの設計正典参照)。幾何仕様を
│   │   │                           変えるときはリポジトリをまたいで両側を突き合わせる
│   │   ├── rendering.ts        — 座標変換 + slice path + text + 視覚 em 推定
│   │   ├── post_layout.ts      — overlap 解消 / compactify cascade /
│   │   │                         半角カナ fallback / 視覚 viewBox nudge
│   │   └── font.ts             — TTF → WOFF2 サブセット埋込 (async I/O + キャッシュ)
│   ├── runtime/                — SEA(単一 exe)実行時のガード
│   │   ├── seaRuntime.ts       — アセット許可リスト + builtin 以外のモジュール解決封鎖
│   │   ├── subsetFontFs.ts     — subset-font へだけ差し込む fs shim (wasm を SEA アセットへ)
│   │   ├── nativeDriver.ts     — exe に埋め込んだ DB ドライバの書き出し・照合・後片付け
│   │   ├── dbChild.ts          — DB 取得を行う子プロセス (`__db-fetch`) の親側と子側
│   │   ├── msDriver.ts         — msnodesqlv8 の読み込み (開発版 / exe の違いを吸収)
│   │   └── sqlserverv8Shim.cjs — msnodesqlv8 のドライバ読み込みの差し替え先
│   │                             (ビルドの esbuild plugin だけが読むので knip.json に entry 登録)
│   ├── types/
│   │   └── subset-font.d.ts    — subset-font の型宣言 (公式の型が無いため)
│   ├── verify/
│   │   ├── svg.ts              — 自動検証 (独立オラクル)
│   │   ├── consistency.ts      — 採点判断 ↔ emit SVG の一致検証
│   │   └── verify/oracle_sync.ts      — オラクル複製定数の drift ガード
│   ├── cli.ts                  — CLI (list / one / batch)
│   └── test_batch.ts           — 83 件一括生成 + compare.html
└── scripts/                    — build-exe.mjs / sign-exe.ps1 / new-signing-cert.ps1 /
                                verify-dist.ps1 / sidecar-pins.json / gen_glyph_advance.ts
```

## アーキテクチャ

> 配置パイプラインの**設計正典は `docs/pie-chart/src/設計正典.md`**（旧 `ARCHITECTURE.md`。
> モード×パス対応表・do-no-harm ゲート使い分け・却下済み設計案）。本節は概観のみ。

レンダリング層は外部ライブラリを使わず、**プレーンな TypeScript で SVG タグの文字列を組み立てる**。Node でもブラウザでも同一コードが動く(DOM API・`<canvas>`・selection 抽象に依存しない)。Excel 入力のみ `exceljs`(`input/load.ts`)、フォント埋込のみ `subset-font`(`svg_export/font.ts`)に依存し、いずれも端の層に隔離している。

```
入力 (samples.json / JSON / 配列 / xlsx / DB)
   │  (input/load.ts: normalizeInputItems / resolveInputData{,Async}、DB は input/db.ts)
   ▼
Item[] {name, value}
   │
   ▼
renderPdfStylePieToSvg (async, svg_export/pipeline.ts)   ← 最終アセンブリ・leader 磨き Pass 群
   ├─→ config.ts             createPieLayoutConfig / makeColors          (寸法・スケール・配色)
   ├─→ layout/diagnostics.ts layoutLabels                                (論理座標でラベル位置決定)
   ├─→ svg_export/rendering.ts  createCoordinateSystem / buildSlicePath / computeArcs / textFragment
   ├─→ layout/placement.ts   build*Draft / finalizePlacement / leaderPath (経路選択 + 引出線 path)
   ├─→ svg_export/post_layout.ts  resolveLabelOverlaps / runCompactCascade /
   │                              applyVisualViewBoxNudge
   └─→ svg_export/font.ts    buildFontFaceDefs                           (TTF → WOFF2 埋込)
   ▼
RenderResult { svg, diagnostics, config }
```

### レイヤごとの役割

| レイヤ | ファイル | 責務 |
|---|---|---|
| 型 | `src/types.ts` | 全体共通の TS interface(`Item` / `LayoutItem` / `Placement` / `Diagnostics` / `PieLayoutConfig` 等) |
| データ | `src/input/load.ts` + `samples.json` + `src/input/db.ts` | サンプル読込、JSON / Excel / DB(SQL Server) 入力、`{name, value}` 正規化 |
| 設定 | `src/config.ts` | pt 基準寸法・フォント・派生スケール getter 群(`createPieLayoutConfig`)+ 配色(`makeColors`) |
| レイアウト | `src/layout/diagnostics.ts` | 論理座標系でのラベル位置決定(左右割当・Y 解決・上左カスケード・X 配置・flip 判定)。`layoutLabels` を section 構成 |
| 幾何 | `src/layout/geometry.ts` | 純粋幾何/測定/ナッジ系ヘルパー(座標変換なし、SVG 文字列生成なし、副作用なし) |
| 経路選択 | `src/layout/placement.ts` | 形ごとの `build*Draft` 群と共通後処理 `finalizePlacement`。引出線 SVG path(`leaderPath`)と end-point / segment ナッジ |
| 描画 | `src/svg_export/rendering.ts` | 論理座標 → SVG pt への座標変換、スライス path・テキスト要素、視覚 em 幅推定(純粋関数) |
| 後処理 | `src/svg_export/post_layout.ts` | overlap 解消(対角押し + 縦分離の 2 パス）・compact cascade・半角カナ fallback・視覚 viewBox nudge |
| フォント | `src/svg_export/font.ts` | WOFF2 サブセット埋込(async I/O + キャッシュ。`subset-font` 依存、失敗時は full TTF に fallback) |
| 統合 | `src/svg_export/pipeline.ts` + `mode_passes.ts` + `emit_repair.ts` | `renderPdfStylePieToSvg` の最終アセンブリ、leader 磨き Pass 群 |
| エントリ | `src/cli.ts` / `src/test_batch.ts` / `src/verify/svg.ts` / `src/verify/consistency.ts` | CLI / 一括生成 + ビューア / 自動検証 / 採点↔emit 一致検証 |

### ラベル配置の流れ(`layout/diagnostics.ts` 核心部）

1. **角度計算** (`calcMidAngles`) — 各スライスの中心角度を `startangle` から累積
2. **プロファイル化** (`buildProfiles`) — 角度から `side` (left/right)、`isUpperLeft`、`isSmall`、`isLong` 等のフラグ
3. **混雑診断** (`runDiagnostics`) — 領域別カウントから `upper_left_small_dense`、`top_small_dense` 等の `modeTags`
4. **Y 解決** (`resolveSidePositions`) — 左右各サイドで `gap` を確保しつつ縦位置を反復調整
5. **flip 判定** (`flipUpperLeftStackToRight` / `applyFlipToRight` / `applyBottomFlipToLeft`) — 左上スタックが上端を超える/下帯が混む場合に反対側へ flip
6. **上左カスケード** (`assignUpperLeftRenderY`) — 上左象限は専用処理で上方向にスタック
7. **X 配置** (`placeX`) — 楕円リング上に配置: `x = √(r² - y²) × xScale`

### 配置の下書き(`layout/placement.ts`)

カスケード(`svg_export/pipeline.ts`)が rank ごとに形を選び、`build*Draft` が配置の下書き(`PlacementDraft`)を作り、`finalizePlacement` が nudge・bbox・pie クリアランス・viewBox クランプを共通で掛けて `Placement` に確定する。引出線の SVG path は `leaderPath` が組む。

- `buildInsideDraft` — スライス内部に収めるラベル(引出線なし)
- `buildOutsideRimDraft` — 円外 rim の既定経路。上部「その他」の右上逃がし・クラスタ右逃がし・6 時直下中央など、角度ゾーン別の特殊経路を順に試す
- `buildOutsideLeaderDraft` — 最終手段の放射引出線
- `buildLowerLeftDropLeaderDraft` — 9 時直近の幅広長名を水平軸下へ 2 行ドロップ

`svg_export/rendering.ts` の `textFragment` が `<text>` を組み立て、`svg_export/post_layout.ts` の `resolveLabelOverlaps` がラベル同士の重なりを反復解消する。

### 分割方針

- **`layout/diagnostics.ts` / `layout/placement.ts` は 1 ファイル**: 公開関数は少数 (`layoutLabels` / `finalizePlacement` と `build*Draft` 群) で、サブモジュール化は内部詳細にすぎず grep 性が下がる。section header コメントで「profiles / diagnostics / ...」を識別できれば十分
- **`svg_export/` は subdir 維持**: rendering (純粋関数) / post_layout (placement 修正) / font (async I/O + 独自依存) / orchestrator は性質が異なるため分けるメリットあり

## 触りやすさマップ（どこから触るか / どこは慎重に）

初めての変更は 🟢 から着手し、🔴 は設計正典（`docs/pie-chart/src/設計正典.md` の
「触る前のチェックリスト」）を読んでからレビュー付きで触ること。

| ゾーン | 場所 | 理由 |
|---|---|---|
| 🟢 まず触ってよい | `src/layout/geometry.ts` | 副作用なしの純粋幾何ヘルパー約 60 個。`test/geometry.test.ts` が手厚い |
| 🟢 | `src/config.ts`・`src/input/` | 定数の集約・入力正規化。端の層に隔離済み |
| 🟢 | `src/verify/oracle_sync.ts` | 定数追加は照合付きで安全 |
| 🟡 局所なら可 | `src/layout/placement.ts` | `build*Draft` は配置の形ごとに独立。1 関数の理解で 1 ケース触れる |
| 🔴 レビュー必須 | `src/svg_export/emit_repair.ts` | パス順序・stage/gate・循環 import・FP 演算順序が絡む最難関 |
| 🔴 | `src/svg_export/pipeline.ts`・`mode_passes.ts` | orchestrator と fallback 群・モード特化パス |
| 🔴 | `src/layout/diagnostics.ts` のモード判定 | フラグ間の相互作用が非自明（`mark_flags` ゴールデンが分布を固定） |

`src/glyph_advance/*` は生成物（`npm run gen:widths`）なので手で編集しない。

## コメント規約

コメント規約の正典は **`docs/コメント規約.md`**（全プロジェクト共通）。言語・識別子バッククォート・
クロスファイル参照・体裁（`=` 罫線の装飾ボックスヘッダ、`// ── N. ラベル ──` 節区切り）など
共通事項はそちらを参照すること。pie-chart もこの規約に準拠する。

- **出力不変の検証（pie-chart 固有）**: コメントのみの変更でも `out/_baseline` に対し SVG の
  byte-diff で出力が完全に不変であることを確認する（`npm run batch` → `npm run batch:diff`。
  下記「検証」節参照）。これは SVG 出力の決定性に密な pie-chart 限定の鉄則。

## 検証

SVG 出力は**完全に決定的**なので、リファクタ・コメント変更の挙動保証はバイト単位で行う。

- **byte-diff**: `npm run batch` → `npm run batch:diff`。`scripts/batch_diff.mjs` が
  `out/svg_js` ⇔ `out/_baseline` を SHA256 で全件比較し、差分があれば非 0 exit +
  ファイル名を列挙する。列挙は 3 種で、内容の相違だけでなく **baseline に無い出力（追加）**と
  **出力に無い baseline（欠落）**も差分として扱う。
- **`npm run batch` は毎回 `out/svg_js` の SVG を消してから生成し、1 件でも生成に失敗すると
  非 0 で終わる**。前回の出力が残っていると、レンダーに失敗したサンプルの古い SVG が
  baseline と一致して byte-diff が OK を返してしまうため（「生成できなかった」が「差分が無い」
  と同じ結果に見える状態を作らない）。
- **baseline の初回作成 / 更新**: `out/_baseline` はローカル生成物（git 管理外）で clone 直後は
  存在しない。**必ずコミット済みのクリーンな状態で** `npm run batch` → `npm run baseline:accept`
  を 1 回実行して基準を作る。出力変更を意図した確定時も同じコマンドで更新する
  （未検証の変更を基準に凍結すると以後 byte-diff が退行を検出できなくなる）。
- **`npm run verify` は `out/svg_js` の既存 SVG を読む（再レンダーしない）**。コード変更後は
  必ず `npm run batch` を先行させてから verify / `npm run verify:consistency` を読む。
- **特性テスト**（`npx vitest run`）: byte-diff はサンプル入力の分布しか守らないため、特性テストで
  穴埋めしている — mark_flags（mark*** 発火表）/ final_score（finalScore ゴールデン）/
  render_hash（サンプル外合成入力の SVG ハッシュ）/ seam_snapshot（revert 完全性 +
  `PLACEMENT_SEAM_POLICY` 網羅表）/ emit_passes（emit/scoring パス列固定）。
  スナップショット更新（`-u`）は挙動変更を意図した時のみ許される。
- **配布 exe の閉包検査**（`test/sea_packaging.test.ts`）: 既定 **skip**。exe を作ってから
  `PIECHART_SEA_TEST=1 npx vitest run test/sea_packaging.test.ts` で有効化する。exe の隣・
  上位ディレクトリに偽 `node_modules/subset-font` と偽 `fonts/` を置いてなお、出力が開発版と
  byte 一致し偽モジュールが実行されないことを見る。配布前は `scripts/verify-dist.bat` も通す。
- **デバッグ**: `PIE_CHART_DEBUG_REPAIR=1` で emit 修復パス単位の RepairVec 差分ログ、
  `PIE_CHART_STOP_AFTER_PASS=<name>` で犯人パスの二分探索（`EMIT_REPAIR_PASSES` の name を指定）。
- **do-no-harm の採否述語（better / swapBetter 等）はパス仕様そのもの** — ヘルパーへ焼き込まず、
  一字一句変えない（FP 演算順序が変わると数学的等価でも byte が動く）。

### 初心者向けの落とし穴（等価に見えるのに壊れる 2 大制約）

- **FP 演算順序への依存**: 出力は byte 単位で決定的なため、数学的に等価な式変形
  （例: `a*b + a*c` → `a*(b+c)`）でも浮動小数の丸めが変わり出力 byte が動く。
  「等価だからリファクタしてよい」は本プロジェクトでは成り立たない — `batch:diff` で必ず確認する。
- **循環 import + 関数宣言 hoisting 依存**: `emit_repair.ts ⇄ pipeline.ts ⇄ mode_passes.ts` は
  相互 import しており、関数宣言の hoisting によって初めて安全に動いている。ここへ
  トップレベル評価（定数の即時初期化など）を持ち込むとランタイム未定義エラーを踏む。
  import を追加・並べ替えする前に各ファイル冒頭の設計コメントを読むこと。

## 注意

- `1 viewBox unit = 1px` 固定。キャンバスは **600×450px 固定**(`config.ts` の `svgWidthPx` / `svgHeightPx`）。
- 円グラフ本体の直径は**高さの 70% 固定**(`pieHeightRatio` 0.7)で、**fontSize 非依存**。pie は常にキャンバス中央に置かれ、横余白は `(svgWidthPx − 直径) / 2` で自動決定される。
- 文字サイズは `config.ts` の `fontSize` 既定 **40**(`baselineFontSize` 20 を基準に派生スケールが連動）。実描画は `fontSize × textRenderScale`(=40×0.68=**27.2px**) で `<text font-size>` に出力される。
- 長体 (nameScaleX) は**ラベル単位**: はみ出すラベルだけ `applyFinalCondenseToFit` で縮め、`relaxNameCondense` がキャンバス・pie・隣接ラベルに当たらない範囲で原寸 (sx=1 上限) へ戻す。旧来の「1 つでも長体なら全ラベルを統一圧縮」は廃止 (収まるラベルは原寸のまま)。
- **上部「その他」の右上逃がしは pie キャップ上へ持ち上げる** (`layout/placement.ts` `topRightLiftedRimDraft`): 箱下端を `pieRadius + クリアランス` に揃え (= 箱全体が円の上)、`pieClampXLimits` が横押し出しを起こさないようにして短い縦/斜め leader で結ぶ。`topBandSonohokaRight` 右パス / `topBandSmallRight` / `clusterTopBandBottomRight` が共有。旧実装は箱下端が円の y 域に入り pie クリアランスが textX を右へ押し出し、100〜180px の水平 leader がチャート上部を横断していた。
- **下限長体でも見切れる長名は標準 2 行化で収める** (`svg_export/pipeline.ts` の `applyTwoLineNameFallback`, emit 最終段): 名前を語中で割らない標準 2 行 `[名前, %]` へ変換し、名前行だけになって箱幅が縮む分だけ見切れを減らす。語割れ (旧 `splitLongName` / `applySplitNameFallback`) は pie-chart 全体で廃止した。採否は対象自身の見切れ px 厳密減 + `countDefects` の他カテゴリ非悪化の do-no-harm ゲートで決め、満たさなければ revert する。採点 (`finalizeForScoring`) には入れず emit のみ (候補選択を乱さない / finalScore は emit 後の同 placements から数えるため scorer↔emit 整合は保たれる)。
- **fontSize=40 での tight-pack warning(現況: 2026-07-21 再計測)**: 現行設定 (600×450px / 直径 70% / fontSize=40) では `npm run verify` が **5/83 サンプル**で警告する(計 8 件)。警告は全て WARN 級(ERROR 級の leader 交差/円内貫通は 0 を維持)。内訳:
  - label viewBox はみ出し: 8 件(**大半は condense-to-fit / 標準 2 行化で縮小済**。残るのは下記の構造的残件。対象: `asset_12_long_and_tiny` / `asset_gbca_pdf_like` / `asset_long_labels_9` / `currency_europe_heavy_8` / `ten_elements_long_upper_left`。`currency_many_small_10` は左列 overpack 時の右上逃がし (packing 枝) + 2 行化で解消済)
  - leader 交差: **0 件** / leader 円内侵入: **0 件** / leader through label: **0 件** / label inside pie: **0 件**(`test/leader_invariants.test.ts` が回帰 9 サンプル + 番兵 3 サンプルで不変条件をガード)
  - label overlap: **0 件** / label order inversion: **0 件**(いずれも過去の残件は解消済)
- **構造的に残る viewBox はみ出し(対象外として既知)**: いずれも長名を `applyFinalCondenseToFit`(下限 sx=0.7)・`applyTwoLineNameFallback` の標準 2 行化でも収まらないケース。
  - 長カタカナ単一語(`スウェーデンクローナ`(europe_heavy_8)/`オフショア人民元` 等): 600×450px / fontSize 40 では 2 行化しても名前行 (`スウェーデンクローナ` 等) が canvas 幅を超える密スタック位置に残る。`ニュージーランド・ドル` 等、上部の細い pie 帯に置ける長名は 2 行化で解消済。many_small_10 の `ノルウェークローネ`/`スウェーデンクローナ` は右上逃がし (packing 枝) で左列が緩み解消済。
  - 支配スライス右端(`債券先物(イギリス) 41.8%`): rim 右端に配置余地なし。中央下/スライス内誘導はカスケード新規追加(別タスク)。
  - これらの解消は**別タスク**で対応する。値が動いたら本節を更新すること。**新規回帰と区別すること**。
- TypeScript は `strict: true`(`noImplicitAny: false` で段階導入、`strictNullChecks: true` 有効）。
