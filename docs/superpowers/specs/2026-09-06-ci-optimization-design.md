# CI 最適化 — 設計

- 日付: 2026-09-06
- 状態: **承認待ち**(反対目線レビュー 2 巡で収束: 1 巡目 BLOCKER 6 / MAJOR 21、2 巡目 MAJOR 1 →
  すべて反映済み)
- 前段: `2026-09-06-ci-optimization-dig.md`(論点と決定の記録)。本書は決定を設計へ写し、
  レビューで判明した事実により一部の決定を**置き換える**(置き換えた箇所は「dig からの変更」と明記)。
- 目標: (1) フル `pnpm run ci` をこの端末(8 コア / 8GB)で 10 分未満に保つ。(2) CI の穴
  (検査の抜け・flaky・未被覆)を閉じる。(3) pie-chart の配置計算が 12 項目 × 長名で 1 枚 65 秒
  かかる製品性能バグを、SVG 出力を 1 バイトも変えずに直す。

## 0. 実測(2026-09-06、この端末)

| 段 | 所要 | 備考 |
|---|---|---|
| check:comments / claude-hooks / biome / test:scripts | 16s | |
| typecheck:editor | 11s | |
| test:editor(coverage 無し、2367 件) | 104s | jsdom 起動の積算 173s + import 62s + テスト本体 67s を 4 workers で分担 |
| test:coverage(全 4 project) | 276s | 臨界経路 = `render_hash.test.ts` 242s |
| pie-chart 単独(coverage 無し) | 131s | `render_hash` 128s / `final_score` 35s / `leader_invariants` 19s |
| build:editor | 13s | |
| e2e(35 件、4 workers) | 72s | 合計 262s、並列効率 91%。server / vite は暖機状態 |
| `pnpm run ci`(cold・全段の壁時計) | 383s | dev サーバ未起動・並走負荷なし。段の合算(約 6.5 分)との差は e2e の webServer 起動と coverage の集計 |

段の合算は約 6.5 分。cold(dev サーバ未起動)で 1 本通した壁時計は上表の最終行(計画 A の最初の
タスクで計測。10 章)。
記憶にあった「11〜12 分・coverage 7〜8 分」は 2026-08-08 の値で、現状より 5 分以上長い。

`render_hash` の 26 ケースのうち `gen_long_12_other`(1 ケース約 65 秒)が支配的。
`gen_long_14_other` は正規化(`|value| > 0` フィルタ)で値 0 の 2 項目が落ちて `gen_long_12_other` と
**同一入力**になる(`.snap` のハッシュも同一)。つまり重いのは「n=12 の長名」1 系統で、n=14 の
ケースは同じ計算をもう 1 回している。

CPU プロファイル(inclusive): `pickUpperEscapeCount` → `upperEscapeScore` 117s、
`applyEmitRepairPasses` → `repairResidualLeaderDefects` → `tryRebendInvolved` 80s、`tryBendGridOn`
37s、`placementBox` → `placementExtent` → `scaledLabelWidthUnits` → `visualMaxEm` 61s(self 42s)。
`visualMaxEm` は既に文字列キーのメモ(`LINE_EM_CACHE`)を持つので、self 42s は Map 引きの回数
そのものを表す。

## 1. 分割

1 つの設計を 3 つの実装計画に分ける。

| 計画 | 章 | 内容 |
|---|---|---|
| **A: CI の速度と構造** | 2, 3, 4, 5, 6.1(docs project のみ), 9 | pie-chart 高速化、render_hash 分割、CI スクリプト同期、web vitest 分割、capture_docs の project 分離、GH Actions |
| **B1: e2e と注入** | 7, 6.1(rest project), 6.2, 6.3 | sproc 注入 → rest e2e、`waitForTimeout` 撤去、挙動 spec |
| **B2: 被覆** | 8 | `api/rest/*` 直接テスト、38 ファイルの底上げ、routes の include、perFile |

A は B1 / B2 に依存しない。B1 の中では 7 章(注入点)が rest e2e に先行する。B2 のうち sproc モックに
触れる server テスト(reviews 系 3 件・`draftFiles`・`projectConfig`)だけは B1 の注入化の後に書く。
web / pie-chart の底上げ(30 件超)と `api/rest/*` の直接テストは B1 と独立で、並行してよい。

## 2. pie-chart 高速化(SVG バイト不変)

### 2.1 熱源(dig からの変更)

dig の決定「文字列→幅キャッシュ → 計測 → `layoutLabels(rotate, count)` のメモ」は、実装を読むと
どちらも効かない。

- 文字列→幅キャッシュは `layout/geometry.ts` の `LINE_EM_CACHE` として実装済み。
- `pickUpperEscapeCount` の `layoutLabels(items, cfg, rotateOverride, count)` は `count` ごとに
  1 回しか呼ばれず(`pipeline.ts:1136`)、同一キーの再呼出が無い。

真の熱源は次の 2 つ。

1. `measureRepairVec`(`emit_repair.ts:1554-1570`)が `countLeaderCrossings` / `leaderPieCrossCount` /
   `countLeaderThroughLabels` / `oobLeaderCount` を順に呼び、それぞれが `realLeaderPaths`(内部で
   `computeDrawnLeader` → `placementBox`)を独立に計算する。1 回の採点ベクトル計算で同じ leader
   折れ線と box を 4 回以上作り直している。`tryBendGridOn`(`emit_repair.ts:1753-1787`)は
   5×6 の格子 × 関与 leader × 最大 6 反復でこの採点を呼ぶ。
2. `boxOverlapMax`(`leader_geometry.ts:946-957`)が O(n²) の内側で対ごとに `placementBox` を呼ぶ。

`leaderThroughPairs` / `leaderCrossingPairs` は既に関数冒頭で box と path を 1 回計算しており
(`leader_geometry.ts:812-829, 847-864`)、対ごとの再計算はしていない。

### 2.2 段階と受入条件

各段でコミットし、`npm run batch` → `npm run batch:diff`(`out/_baseline` と byte 一致)と、
`render_hash` / `final_score` / `mark_flags` のゴールデン不変を確認する。

| 段 | 内容 | 出力への影響 |
|---|---|---|
| 1 | 計測フック: `placementBox` / `realLeaderPaths` / `measureRepairVec` / `tryBendGridOn` の呼出回数をカウントする開発時オプション。`placementBox` は約 100 箇所から呼ばれ到達できる引数が `cfg` だけなので、カウンタは `options` → cfg のフィールド(`PieLayoutConfig` に任意フィールドを追加。`{ ...cfg, textColor }` のコピーも同じ参照を共有する)として渡し、テスト・計測スクリプトからだけ与える。既定は無効で分岐は 1 つの `if` | 無し |
| 2 | `measureRepairVec` で `realLeaderPaths` と投影済み box 配列を 1 回だけ計算し、各計数関数へ渡す(既存の export 関数は薄いラッパとして残し、内部関数が配列を受け取る)。`boxOverlapMax` も box 配列を受け取る形にする | 無し(計算順序と FP 演算は不変) |
| 3 | 計測 → 未達なら `placementExtent` の placement 単位メモ: `WeakMap<Placement, { lines, nameScaleX, nameSplit, extent }>`。3 フィールドが参照一致するときだけ再利用する | 無し(純関数のメモ) |
| 4 | 計測 → 未達なら `tryBendGridOn` の候補ループで「曲げ対象以外の leader と box は候補間で不変」をループ外へ持ち上げる。`measureRepairVec` に「事前計算した paths / boxes を受け取り index i だけ再計算する」引数を足す(段 2 の形が前提) | 無し |

段 3 の根拠(レビューで確認済み): `placementExtent` が読む cfg フィールドは `fontWeight` /
`visualFullwidthEm` / `visualHalfwidthEm` / `fontSizeMm` / `charWidthFactor` / `textRenderScale` /
`mmPerUnit` / `lineHeightFactor` のみで、描画中に変異する `pieLabelClearance` を含まない。
`lines` / `nameScaleX` / `nameSplit` の変更はすべて代入置換で in-place 変更が無い
(`seamSnapshot` のコメントが規約として明記)。`item.name` / `percentText` への代入は 0 件。

受入条件: `gen_long_12_other` 単独 5 秒以下(`gen_long_14_other` は同一入力なので個別条件を
置かない)、`render_hash.test.ts`(24 ケース)単独 30 秒以下。未達なら出力の変更を伴う案は
**本計画では扱わず**、別計画に起こす。

### 2.3 してはならないこと

- 反復中に placement を動かす関数(`iterateOverlapPairs`: `post_layout.ts:211-240`。`resolvePair`
  が a / b を更新した後に次の対で `placementBox(a)` を読み直す)は巻き上げの対象にしない。
  box を冒頭で固定すると移動後の対判定が変わる。
- モジュールグローバルのメモを**新設**しない(既存の `LINE_EM_CACHE` はそのまま)。段 3 の `WeakMap`
  は placement の寿命 = 1 回の描画に閉じる。
- `{ ...cfg, textColor }` のような cfg のコピーを extent 系の関数へ渡す経路を作らない
  (段 3 のメモは cfg をキーに含めないため)。
- 早期打ち切り(`upperEscapeScore` の悪化で以降の候補を捨てる)は採らない。選択結果が変わりうる。
- `EMIT_REPAIR_PASSES` の順序・stage には触れない。

## 3. render_hash の分割(dig からの変更: 3 ファイルではなく 2 ファイル、`.snap` ではなく定数表)

- 2 ファイルに分ける。`gen_long_12_other` と `gen_long_14_other` は同一入力なので、別ファイルに
  分けても同じ 65 秒を 2 つの worker で 2 回やるだけになる。
  - `render_hash.test.ts`: n ≤ 10 の 18 ケース + `gen_short_12_other` + `gen_short_14_other` +
    特殊形 4 = 24 ケース。
  - `render_hash_long.test.ts`: `gen_long_12_other`、`gen_long_14_other` の 2 ケース。
- ケース生成(`makeItems` / `syntheticCases`)は `test/helpers/syntheticCases.ts` へ移して共有する。
- 各ケースを `it.each` で 1 つの `it` にする。
- 期待値は `.snap` ではなく**定数表**にする: `test/helpers/renderHashExpected.ts` に現行
  `__snapshots__/render_hash.test.ts.snap` の 26 エントリを `{ ケース名: SHA256 }` として写し、
  `expect(hash).toBe(EXPECTED[name])` で比較する。`.snap` は削除する。理由: vitest はローカル実行で
  未知の snapshot 名を**黙って書き足す**(`updateSnapshot` 既定 `'new'`)ため、移行時に名前を 1 文字
  違えると旧ハッシュが検査されないまま緑になる。定数表なら `-u` も無言の追加も存在しない。
  ハッシュ値は 1 バイトも変えない(移行は現行 `.snap` からの機械的な写しで、目視確認を
  受入条件に含める)。ケースの脱落は `expect(hash).toBe(undefined)` では検出できないので、
  `Object.keys(EXPECTED)` と生成ケース名の集合が一致すること(26 件)を `it` 1 本で固定する。
  `test/helpers/*.ts` は `typecheck:pie-chart`(include = `src/**`)の対象外で、既存の `test/` と
  同じ扱い。
- timeout: `render_hash.test.ts` はケース単位 60 秒。`render_hash_long.test.ts` は 2 章の受入達成
  **まで**ケース単位 300 秒(`final_score.test.ts` と同じ判断)、達成後に 60 秒へ縮める。
  分割コミット時点で 60 秒にすると、2 章が未達で本計画を閉じた場合に必ず落ちる。
- n=14 のケースが n=12 と同じ分布しか守っていないのはテスト設計の穴だが、`makeItems` を直すと
  ハッシュが変わるため本計画では触らない。事実を `render_hash_long.test.ts` のコメントに残し、
  別計画(`-u` 相当の意図的な期待値更新)へ回す。

## 4. CI スクリプトの同期

### 4.1 `ci` の段構成

`package.json` の `ci` を次にする(順序も正典):

```
check:comments → check:claude-hooks → check:ci → test:scripts → typecheck → test:coverage
→ test:docs → pie-chart:batch → pie-chart:batch:diff → build → test:e2e
```

`ci-affected.mjs` の `runFullCi` は `ci` を呼ぶだけなので自動で追随する。

`pie-chart:batch:diff` は `out/_baseline`(git 管理外のローカル生成物)が無いと落ちる。これは
`pie-chart/README.md` 検証節の規則どおり(「無ければ落とす」。決定はユーザー)。clone 直後の端末では
`pnpm run ci` の前に、コミット済みのクリーンな状態で `baseline:accept` を 1 回打つ。この手順を
ルート `README.md` の CI 節へ書く。GH Actions には置けない(4.3 の免除リスト)。

`test:docs` は `py -3.13` と `docs/_build/dev-requirements.txt` の pytest を前提にする。オフライン
配布先では wheelhouse が `dev-requirements.txt` を数えていること(`offline/lib/content-key.ps1`)が
前提で、これは既に満たされている。

### 4.2 `ci-affected.mjs` の領域判定

- `BENIGN_FILES`(完全一致)を新設し、**領域判定より前**に評価する: `README.md`、`editor/README.md`、
  `pie-chart/README.md`、`.gitignore`。README だけの editor 変更で editor 領域の CI を飛ばすのが
  意図。`.gitattributes` は含めない(Biome の eol 前提を変えるためフル fallback のまま)。
- `scripts/` と `.husky/` は `BENIGN_PREFIXES` から外し、stages が空の領域 `ci-machinery` として
  登録する。効果は「共有ゲートのみ」で従来と同じだが、出力に「領域: ci-machinery(共有ゲートのみ)」と
  明示され、silent skip でなくなる。フル fallback へ回さない理由: `check:comments` と
  `test:scripts`(`ci-affected.test.mjs` を含む)は毎回走っており、フル `ci` が足す coverage /
  build / e2e は `scripts/` の正しさと無関係。
- `BENIGN_PREFIXES` は `['docs/', '.github/']`。`docs/_build/` は従来どおり `docs` 領域(`test:docs`)。

### 4.3 手同期をやめる機械検査

`scripts/ci-affected.test.mjs`(`node:test`)に追加する。`.github/workflows/ci.yml` を行ベースで
読み(`- name:` で step を区切り、`run: |` の継続行を連結する。YAML パーサは root から import
できないので使わない)、各 step の `run:` を次の写像表で `package.json` の script 名へ正規化する:

| yml の run | 段 |
|---|---|
| `pnpm run <script>` | `<script>` |
| `python scripts/check-comments.py` | `check:comments` |
| `python -m pytest docs/_build` | `test:docs` |
| `pnpm install …` / `pnpm exec playwright install …` / `pip install …` | 段ではない(導入) |

検査: 「`ci` の段集合 ⊇ yml の段集合」と「yml の段は `ci` と同じ相対順序で並ぶ」。`ci` にあって yml に
無い段は免除リストに理由付きで列挙し、免除リスト外の欠落は赤にする。現行 `ci.yml` は
`check:comments` が coverage の後(`Setup Python` が途中にある)なので、この検査の追加と 9 章の
yml 並べ替えは**同一コミット**で行う。併せて `ci-affected.test.mjs` に 4.2 の判定
(`scripts/x.mjs` だけの変更 → 共有ゲートのみ、`editor/README.md` だけの変更 → 共有ゲートのみ)を足す。

| 免除 | 理由 |
|---|---|
| `check:claude-hooks` | `.claude/` は git 追跡外で、GH の checkout では検査対象が無い(exit 0 になるだけ) |
| `pie-chart:batch` / `pie-chart:batch:diff` | `out/_baseline` はローカル生成物で GH に存在しない |
| `ci:offline` | Windows 限定の Pester(`ci` にも無い。従来どおり `runFullCi` が別途呼ぶ) |

### 4.4 スクリプトの整理

- `test:e2e` = `playwright test -c editor/playwright.config.ts --project chromium`(`ci` と GH)。
  現行は project 無指定で、6.1 の `docs` project を作った瞬間に `ci` でも撮影が走るため必須。
- `e2e:editor` = 同 `--project chromium --project docs`(`ci:affected` の editor 領域)。
- `e2e:rest` = `E2E_REST=1 playwright test -c editor/playwright.config.ts --project rest`(計画 B1 で
  追加。`E2E_REST=1` を裸の `playwright test` に付けると webServer が rest 側へ切り替わったまま
  `chromium` / `docs` project も rest サーバ相手に走るため、project 指定を固定する)。
- `build:editor` は `pnpm run build` の別名にする(本体を 1 か所にする)。

## 5. web vitest の project 分割(dig からの変更: ネスト projects は使えない)

vitest 4.1.11 は、参照 config 内の `test.projects` を**無視する**(レビューで実測: 全ファイルが
`web` として node 環境で走り、`--project web:dom` は "No projects matched")。よってルート
`vitest.config.ts` の `projects` に 2 エントリを直接列挙する。

- `editor/web/vitest.dom.config.ts` と `editor/web/vitest.node.config.ts`(leaf)を新設する。どちらも
  `mergeConfig(viteConfig, defineConfig({ test: … }))` で `vite.config.ts` を取り込む(`vue()`
  プラグインと `resolve.alias` は `test` ブロックの外にあり、`vitest.config.ts` が存在すると
  `vite.config.ts` は読まれないため)。
  - `web-dom`: `environment: 'jsdom'`、`include: ['test/**/*.dom.test.ts']`。
  - `web-node`: `environment: 'node'`、`include: ['test/**/*.test.ts']`、
    `exclude: [...configDefaults.exclude, '**/*.dom.test.ts']`(素の配列にすると vitest 既定の
    `node_modules` 除外が消える)。
- `editor/web/vitest.config.ts` を **`test.projects: ['./vitest.dom.config.ts', './vitest.node.config.ts']`
  だけを持つ薄い root 設定**として併設する。理由: `pnpm --filter web test <name>`(`package.json` の
  `"test": "vitest run"`)は web ディレクトリで vitest を起動し、自動検出されるのは `vitest.config.*` /
  `vite.config.*` だけ(`vitest.dom.config.ts` は検出されない)。この経路は実際に使われている。
  自身が root として起動されるときの `projects` は動く(無視されるのは「参照 config 内」のネストだけ)。
- ワークスペース root の `vitest.config.ts` は **leaf 2 本を直接列挙**する(`editor/web/vitest.config.ts`
  を列挙すると再びネスト無視になる)。`'editor/web/vite.config.ts'` の行を置き換える。
- `vite.config.ts` から `test` ブロックを撤去する。`editor/web/tsconfig.json` の `include` に 3 つの
  config を足す(vue-tsc の検査対象に入れる)。
- `--project 'web-*'` で両方を選べる(ワイルドカード対応)。`test:editor` は
  `--project shared --project server --project 'web-*'`。
- DOM 依存の判定は実測で決める。初期リネームは `@vue/test-utils` または `.vue` を import する
  **18** ファイル。残りを node で走らせ、`document is not defined` 等で落ちたものを `.dom.test.ts` へ
  移す。`src/lib/draftOwner.ts` / `src/lib/theme.ts` / `src/stores/auth.ts` /
  `src/stores/editorSession.ts` はモジュール直下で `window` / `localStorage` に触るため、これらを
  import するテストは純関数テストでも dom 側になる。最終的な dom 側は 18 より増える見込み
  (grep では 27 ファイルが `document` / `window` に触れる)。
- `editor/README.md` のカバレッジ正典と `ci-affected.mjs` の説明を同じコミットで更新する。
  coverage の include は src 側のパスなので不変。

## 6. e2e

### 6.1 playwright の project

| project | testMatch / testIgnore | 走らせる場所 | 計画 |
|---|---|---|---|
| `chromium` | 既定。`capture_docs.spec.ts` と `*.rest.spec.ts` を ignore | `test:e2e`(`ci`・GH)、`e2e:editor` | A |
| `docs` | `capture_docs.spec.ts` | `e2e:editor`(`ci:affected` の editor 領域)のみ | A |
| `rest` | `**/*.rest.spec.ts` | `E2E_REST=1` のときだけ `projects` 配列に入る | B1 |

`E2E_REST=1` のときの起動:

- server: `editor/server/scripts/e2e-rest-server.ts` を `tsx` で起動(dist 不要)。`buildApp` を
  sproc フェイク付きで rest モード(`AUTH_REQUIRED=true`、`AUDIT_DB=true`)、`PORT=24690`、
  `DATA_ROOT` は一時ディレクトリで動かす。起動前に dataRoot を seed する(7 章)。
- web: `VITE_API_MODE=rest` で `vite --port 24691`、proxy 先は新設の環境変数
  `API_PROXY_TARGET`(既定 `http://localhost:24680`。`vite.config.ts` が `process.env` で読む dev
  サーバ設定なので、クライアントへ露出する `VITE_` 接頭辞は付けない)で `http://localhost:24690` を指す。
- `playwright.config.ts` の `baseURL` と webServer の health URL も `E2E_REST=1` のとき
  24691 / 24690 へ切り替える。
- `reuseExistingServer: false`、`workers: 1`(project 単位の `workers` は Playwright 1.62 で有効。
  同一 IP・同一 ID のログインが並列に集中すると `loginRateLimit` に当たり、成功で ID 段が消えるため
  1 で足りる)。ポートを分けるのは、開発中の local サーバが 24680 に居るとヘルスチェックが通って
  しまい rest spec が local 経路で走るため。
- `e2e-rest-server.ts` は `PORT` / `AUTH_REQUIRED` / `DATA_ROOT` を **`serve.ts` の import より前**に
  `process.env` へ置く(`config.ts` は import 時に解決する)。静的 import では一時 `DATA_ROOT` が
  効かないので dynamic import で書く。

### 6.2 `waitForTimeout` の撤去(40 箇所のうち 39)

`smoke.spec.ts:47` の 100ms は「20 回のリサイズ嵐の刺激間隔」で待ちではないため残す。残り 39 箇所を
次の分類で置き換える(実装時に箇所 → 待ち先の表を spec のコメントでなく計画書に持つ):

| 分類 | 箇所数 | 待ち先 |
|---|---|---|
| 追加・削除・解決の直後で、次の `expect(...).toHaveCount / toBeVisible` が既に条件待ちを兼ねる | 14 | 単純削除 |
| login 直後の 800ms | 8 | 既存 `waitForLoaded`(skeleton の消滅) |
| パーツクリック後の 600ms(`comment_panel` / `note_bubble`) | 複数 | `frame.locator('.gjs-selected')` の出現(GrapesJS 既定クラス。アプリ改修不要) |
| GrapesJS 初期化待ち | 複数 | `frame.locator('.page').first().waitFor()`(`canvas.spec.ts:33` の実績ある形。`.gjs-frame-wrapper` は本文が入る前に可視になるため使わない) |
| `capture_docs.spec.ts:66` のポーリング周期 | 1 | `expect.poll` |
| 組版後の再レイアウト(`capture_docs.spec.ts:175, 209`) | 2 | ページ容器の `waitForStableBox` |
| 申請後(`capture_docs.spec.ts:187`) | 1 | toast「確定保存を申請しました」の出現(承認待ちバッジは `MainLayout` が `onMounted` と `route.name` の変化でしか更新せず、`/preview` 上の申請では変わらない) |

- `e2e/helpers.ts` を新設し、`login(page, user, { clearSession })`(8 spec に 3 変種で重複)、
  `waitForLoaded`、`waitForStableBox`、`openEditor` を集約する。
- 撤去後、`CI=1`(GH 相当の `forbidOnly` / reporter 設定)で 3 回連続緑を確認してから `retries: 0`
  にする。pre-push は `CI` 未設定で元々 retries 0 なので、確認は `CI=1` で行う意味がある。

### 6.3 挙動 spec の追加

- local(`chromium` project):
  - `/merge`: 候補を選んで結合を実行する。`page.route('**/api/build/merge', …)` で応答を返し、
    要求本文(選択した文書の並び)を検証する。local モードでも `mergePdfService` は実サーバの
    `/api/build/merge` を叩くため、route で止めないと vivliostyle CLI が本当に走る。
  - 承認タブの「承認する」で区画が決着済み表示に変わる(`localReviewRepo.approveReview` は実装済み、
    既存 spec は差し戻ししか押していない)。
  - 作成タブの属性選択から `/edit/:id?created=1` に到達し、ハイライトが出る(`localTemplateRepo.generate`
    は実装済みで `/api/generate` 不要)。
- rest(`rest` project、最小):
  - ログイン(実 `POST /api/auth/login`、セッション cookie)→ 一覧が出る → 編集画面に**本文が描画される**
    (rest では `filled` が空で共通 sample の差込表示になるため、per-fund 実値のアサーションは書かない)
    → 申請 → approver で承認 → dataRoot に確定ファイルと git コミットが出る(自己承認拒否のため
    ユーザー 2 名)。
  - 管理者のユーザー作成で一時パスワードが 1 回だけ表示される。

## 7. sproc の注入

### 7.1 注入点と伝播

- `buildApp({ sproc = realSproc }: { sproc?: SprocClient } = {})`。`SprocClient = { callSproc }`。
  既定値引数は分岐ではない(本番コードに検証専用の分岐を入れない、の範囲内)。戻り型は変えない。
- セッション: `createSessionStore(sproc)` を `app.decorate('sessionStore', …)` で載せる。
  `middleware/auth.ts` の `loadUser` / `requireAuth` 系は `request.server.sessionStore` から読む。
  ガード関数の**参照同一性**は保つ(`routeGuards.ts` の `levelOf` が `preHandlers.includes(requireAuth)`
  で照合し、`ROUTE_POLICY` の起動時検査もこれに依存する。クロージャ化・ファクトリ化はできない)。
  `FastifyInstance.sessionStore` は既存の `FastifyRequest.user` と同じ module augmentation で型付けする
  (decorator は子コンテキストへ継承され、route の preHandler からの `request.server` は登録先
  インスタンスなので到達できる)。手製 request でガードを直接呼ぶテストのうち `requireAuth` を
  通すのは `mustChangePassword` の 1 件(`requireEditor` / `requireApprover` は `request.user` しか
  見ない)。`auth.localMode` は自前 Fastify に `authRoutes` / `usersRoutes` を register するので
  `decorate` と `deps` の両方が要る。
- 注入面は `db/sproc.ts` に `createSprocClient(query: QueryFn)` を置く形にする。real =
  `createSprocClient(pool.query)`、fake = `createSprocClient(fakeQuery)`。`mapSqlError`(module
  private)を通る経路が 1 本になり、`sprocErrors.test.ts` が既に `pool.js` を差し替えている点と
  同じ差し替え面になる。フェイクは `EXEC <proc> @a=?, @b=?` の assigns 文字列と positional 配列から
  名前 → 値を組む。
- リポジトリ: `createAuthRepo({ sproc, sessionStore })`(`authRepo` は `createSession` /
  `destroySession` を使う)、`createTemplateRepo(sproc)`、`createPartRepo(sproc)`、
  `createUserRepo(sproc)`、`createNoteMasterService(partRepo)`、`createPairSyncService(partRepo)`、
  `createReviewRepo({ noteMaster, pairSync })`。`applyConfirmedSave` は sproc 非依存なので
  `templateRepo.ts` のモジュール直下 export のまま残す(`createReviewRepo` の引数を増やさない)。
  `buildApp` が生成して各ルートへ `register(routes, { prefix, deps })` で渡す
  (`FastifyPluginAsync<{ deps: Deps }>` で型付け。`RegisterOptions & Options` で `prefix` と共存。
  `fastify-plugin` は未使用でカプセル化の問題は無い)。
- 改修対象のルート: `auth`(3 箇所)/ `generate`(2)/ `parts`(4)/ `reviews`(5)/ `templates`(8)/
  `users`(4)の 6 本・約 26 箇所。`history` / `notes` は sproc 非依存で無改修。
- `index.ts` のライフサイクル(起動時全失効・掃除タイマー・listen・shutdown)は `src/serve.ts` の
  `startServer({ sproc? })` へ抽出し、`index.ts` と `e2e-rest-server.ts` の両方がそれを呼ぶ
  (複製すると drift 源になる)。`invalidateAllSessions` / `purgeExpiredSessions` は
  `app.sessionStore` 経由。
- `db/audit.ts`(logger 経由の監査ログ)は `setAuditSink(sproc)` で差し込む。logger がグローバルで
  request にも app にも紐付かないため、これだけはモジュール変数の setter になる。設計書は
  「本番コードに残る検証用の可変点」であることを認め、`buildApp` だけが呼ぶ(他から呼ばない)ことを
  `guardCoverage.guard.test.ts` の走査で固定する。

### 7.2 影響するテスト(dig からの変更: 3 ファイルではなく 17 ファイル)

- `vi.mock('../src/db/sproc.js')` を持つ 8 ファイル: `authRepo` / `generate.routes` /
  `noteMasterService` / `reviews.metaFailure` / `reviews.routes` / `reviews.test` / `routeGuards` /
  `session.test`。`sprocErrors.test` は `pool.js` をモック(そのまま)。
- `auth/session.js` をモックする 9 ファイル: `auth.failureFloor` / `auth.initPassword` /
  `auth.localMode` / `auth.loginIdAlphabet` / `auth.loginRateLimit` / `authRepo` / `generate.routes` /
  `mustChangePassword` / `routeGuards`。注入化で `authRepo` / `loadUser` が session モジュールを直 import
  しなくなると、これらのモックは黙って空振りする。全部を「フェイク or スタブの store を注入する」形へ
  書き換える。
- reviews 系 3 件は「DB 不在でも承認が成立する」ことの固定なので、決定的に失敗する sproc フェイク
  (`callSproc` が常に生 SQL エラー相当を throw)を渡す。
- ソース走査テストの字面依存: `config.security.test.ts:361-365`(`app.ts` の
  `const gateUrl = preAuthGateUrl(request);`)、`loginRateLimit.test.ts:240`(`trustProxy` 不在)、
  `confirmedWrite.guard.test`(import 集合)は改修で壊さない。

### 7.3 フェイク

- 置き場: `editor/server/test/fakes/sprocFake.ts`。単体テストと rest e2e で共用。
- 型検査: `server/tsconfig.json` の include は `src/**` のみ(dist へ emit するため広げない)。
  `server/tsconfig.tools.json`(`noEmit`、include = `test/fakes/**`・`scripts/**`、shared への
  reference は同じ)を新設し、`typecheck` と `typecheck:editor` の**両方**に
  `tsc -p editor/server/tsconfig.tools.json` を足す(`ci` が呼ぶのは `typecheck`。`tsc -b editor/server`
  の後段で shared/dist が解決できることは確認済み)。
- seed のパスワードハッシュは起動時に作る(PBKDF2 120k 回 × 3 名で約 77ms。事前計算は不要)。
- 7 ゲートウェイ × 実際に呼ばれる 20 操作(`session` 5 / `user` 6 / `template` 3 / `part` 2 /
  `sample` 1 / `noteMaster` 2 / `audit` 1)を in-memory の Map で実装する。
- 保つ semantics(sproc の不変則。写さないと rest e2e が偽の挙動を検証する):

| 操作 | semantics |
|---|---|
| `user` `PW初期化` | 除外セッション以外を**同一操作で**失効(設計正典「同一トランザクション」) |
| `user` `PWリセット` | 全セッション失効 + `要パスワード変更`=1 |
| `user` `作成` | 重複 loginId は SQL エラー 50409 相当、既定 `要パスワード変更`=1 |
| `user` `更新` | NULL は据え置き(COALESCE) |
| `session` `取得` | `失効=0 AND 有効期限 > now` のときだけ行を返す |
| `template` `生成登録` | 冪等 |

- エラーは `AppError` を直 throw せず、`number` フィールドを持つ生 SQL エラー相当を `fakeQuery` から
  throw して `createSprocClient` 内の `mapSqlError` を通す(7.1 の注入面)。
- seed(sproc 側): ユーザー 3 名(editor / approver / admin。PBKDF2 ハッシュは起動時に
  `auth/password.ts` の `hashPassword` で作る。`要パスワード変更`=0)、ファンドマスタ(`sample` `取得`
  の `データJSON` は `{ fund: { name }, company: { code, name } }` の形。無いと `parseFundMaster` が
  undefined を返しファンド名が空になる)、`template` の `候補` / `系列` 行は fixtures の sample と
  同じファンドコード。
- seed(dataRoot 側): `web/src/api/fixtures/templates/*.html` と `css/<fund>.css` を一時 `DATA_ROOT`
  へ複写する。一覧・1 件取得・申請はファイル走査(`templateRepo.ts` / `reviewRepo.ts`)で、台帳では
  ない。git は `ensureRepo` が自動 init するので不要。

## 8. 被覆(計画 B2)

1. `api/rest/*` 8 ファイルの直接テスト: `fetch` を `vi.stubGlobal` で差し替え、URL・メソッド・
   本文・エラー写像(401 → セッション失効、`Result` 化)を検証する。
2. perFile は 4 指標すべてに掛かる。85% 未満は statements だけなら 7 ファイルだが、branches /
   functions を含めると **38 ファイル**(決定: 全部書き切る。一時的な低閾値エントリも include 外しも
   しない)。分母が極小のファイル(`syncFiles` branches 1/2、`nunjucksRender` 3/4、`atomic` functions
   2/3)は 1 分岐で赤くなるため、未到達の分岐を狙って書く。一覧(2026-09-06 の `coverage-final.json`):
   - statements: `rest/reviewRepo`(9)、`changedSummary`(75)、`seaRuntime`(75)、`projectConfig`(76)、
     `draftFiles`(79)、`templateCreationService`(80)、`rest/http`(82)。
   - branches: `projectConfig` 69 / `previewHost` 61 / `rest/http` 64 / `local/reviewRepo` 68 /
     `changedSummary` 60 / `PreviewPanel.vue` 75 / `previewSelfContain` 71 / `egressGuard` 75 /
     `buildWorkerPool` 79 / `inlineDocScripts` 79 / `gitRepo` 84 / `templateScripts` 84 /
     `useAutosave` 84 / `geom` 84 / `partKey` 83 / `fillJinja` 83 / `local/templateRepo` 80 /
     `local/partRepo` 77 / `local/historyRepo` 80 / `local/userRepo` 83 / `reviewDiffService` 75 /
     `draftOwner` 81 / `editorSession` 78 / `useCascadingSelect` 79 / `seaRuntime` 74 /
     `pyTemplate` 75 / `syncFiles` 50 / `nunjucksRender` 75。
   - functions: `atomic` 67 / `draftFiles` 64 / `changedSummary` 42 / `templateCreationService` 67 /
     `templateEditorService` 75 / `partNames` 75 / `format` 75 / `mergePdfService` 80 /
     `templatePreviewService` 80 / `historyFiles` 83 / `rest/reviewRepo` 0。
3. `server/src/routes/*.ts` の include: 既存の inject テストが register しているのは `auth` /
   `generate` / `history` / `notes` / `reviews` / `vivliostyle`。`templates` / `parts` / `users` は
   ガード判定のテストからしか到達せずハンドラ本体はほぼ未実行。include 追加前に
   `--coverage.include` の一時指定で計測し、3 本にはハンドラを通す inject テストを書いてから入れる。
4. 最後に `coverage.thresholds.perFile: true`。

## 9. GH Actions

- `concurrency: { group: ci-${{ github.event.pull_request.number || github.ref }},
  cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`(有効な構文)。
- job に `timeout-minutes: 30`。
- `actions/cache` で `~/.cache/ms-playwright`。アクションは**コミット SHA で pin**し版をコメントに残す
  (`ci.yml` 冒頭の規則)。鍵は `pnpm-lock.yaml` から取った `@playwright/test` の版。
- 段の順序を `ci` と一致させる(4.1)。`test:scripts` を追加する。免除は 4.3 の表のとおり。
- `retries: 0` は 6.2 の完了後(計画 B1)。

## 10. 検証

- 計画 A の完了条件: この端末で cold の `pnpm run ci` が 10 分未満、`batch:diff` 一致、3 つの
  ゴールデン(`final_score` / `mark_flags` の `.snap`、`render_hash` の定数表)不変、
  `ci-affected.test.mjs` 緑、`gen_long_12_other` 5 秒以下(未達なら 2 章だけを別計画へ切り出し、
  他は完了とする)。
- 計画 B1 の完了条件: `CI=1` かつ `retries: 0` で e2e が 3 回連続緑、`E2E_REST=1` の project `rest` が
  緑、`pnpm typecheck` にフェイクと e2e エントリが含まれる。
- 計画 B2 の完了条件: perFile 閾値で `test:coverage` 緑、`routes/*.ts` が include に入っている。
- cold の `pnpm run ci` 壁時計は**計画 A の最初のタスク**として測り、0 章の表へ書く(設計時の
  試行は 2 回とも途中で停止され、1 回目は並走負荷で `hostGuard.test` が timeout した。有効な値が
  無いまま「10 分未満」の判定はしない)。段の合算(約 6.5 分)と coverage 段の実測(246〜276s)から、
  分割だけでも 10 分は下回る見込み。→ 実測 383s(0 章の表)。

### 10.1 計測中に観察した flaky 要因(計画 A / B1 で扱う)

- `server/test/hostGuard.test.ts` は実 `app.ts` を dynamic import して `buildApp()` を呼ぶが、
  timeout が既定の 5 秒のまま。レビュアーの並走負荷下で 1 回目の cold 計測がこの 1 件だけ
  timeout で赤くなった(2684 件通過・1 件 5000ms 超過)。資源溢れが「偽の赤」になる既知の形で、
  実 app を import するテストは `projectInput` 等と同じく実測に合わせた timeout を持たせる(計画 A)。
- e2e の後に vite の dev サーバ(24681)が残っていた例が 1 回あった(出所は特定できず)。残った
  サーバは次回の `reuseExistingServer` で再利用され、古いコードで e2e が走る。6.1 の rest 用
  ポート分離と同じ理由で、`pnpm run ci` の前段に「24680 / 24681 が空いていること」の検査を
  `test:e2e` の直前に置く(残っていれば理由付きで落とす。計画 A)。
