# 後始末 計画 D3(コメントと体裁を実態へ揃える)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 計画 A〜C2 が繰り越した軽微項目のうち、コード・文書の記述が実態から少しずれている 7 件を
直す。挙動は一切変えない。

**Architecture:** 1 タスク 1 コミット。テストの実行を伴うのは、コメント以外に触れる 2 件
(撮影の時刻指定、行列確保の位置)だけ。

**Tech Stack:** TypeScript 6 / vitest 4.1.11 / @playwright/test 1.62

**Spec:** なし(繰り越し項目の消化)。出典は計画 B2 / C1 / C2 の台帳とレビュー。

## Global Constraints

- **挙動を変えない**。撮影結果のバイト・SVG のバイト・テストの主張はいずれも変わらないこと。
- **pie-chart を触る Task では SVG バイト不変**: `pnpm --filter pie-chart run batch` →
  `batch:diff` で 83 件一致。
- **コメント規約**(`docs/コメント規約.md`): 日本語散文で「なぜ」を書く。日付・所見番号・経緯・
  計画名やコミット ID は書かない。識別子はバッククォート。1 行は概ね 100 桁。
- **コミット**: 日本語のメッセージ、末尾に
  `Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF`。`git add` は明示
  ファイルのみ。post-commit フックが push と pre-push CI(8〜10 分)を走らせる。amend / rebase しない。
- **重いジョブを重ねない**: 実行前に
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vitest|playwright|ci-affected' }`。

---

### Task 1: 撮影の固定時刻にタイムゾーンを与える

**Files:**
- Modify: `editor/e2e/capture_docs.spec.ts:184`

**Interfaces:**
- Consumes: `page.clock.setFixedTime(date)`。
- Produces: なし。

`new Date('2026-07-10T11:42:00')` はタイムゾーン指定が無く、実行機の地方時として解釈される。
撮影は手元の pre-push 専用なので今は実害が無いが、実行環境が変われば描画される時刻がずれ、
「2 回連続でバイト一致」の保証が崩れる。

- [ ] **Step 1: オフセットを足す**

```ts
  // オフセットを明示する。指定が無いと実行機の地方時として解釈され、撮影する画面の時刻表示が
  // 環境で変わる(バイト一致の前提が崩れる)。
  await page.clock.setFixedTime(new Date('2026-07-10T11:42:00+09:00'));
```

- [ ] **Step 2: 撮影して差分が出ないことを確認する**

Run:
```bash
node scripts/check-ports.mjs 24680 24681
pnpm exec playwright test -c editor/playwright.config.ts --project=docs
git status --short docs/editor/images/
```
Expected: 撮影は緑。`git status` の出力が**空**であること(実行機が JST なので描画される時刻は
変わらない)。時刻が変わって差分が出た場合は、実行機のタイムゾーンを報告したうえで、差分を
コミットするのではなく**オフセットを実行機の地方時に合わせる**(目的は「環境に依存しないこと」)。

- [ ] **Step 3: Commit**

```bash
pnpm exec biome check --write editor/e2e/capture_docs.spec.ts
git add editor/e2e/capture_docs.spec.ts
git commit -m "test(e2e): 撮影の固定時刻にオフセットを与えて実行機の地方時に依存しないようにする"
```

---

### Task 2: 遷移の収束待ちの適用範囲を説明する

**Files:**
- Modify: `editor/e2e/capture_docs.spec.ts`(`waitForTransitionsSettled` の doc とファイル冒頭)

**Interfaces:**
- Consumes: `waitForTransitionsSettled(page)`(同ファイルの helper)。
- Produces: なし。

13 箇所の撮影すべてに一律で掛けているが、実際に必要だったのはタブ遷移の数枚。無害(進行中の
アニメーションが無ければ即座に解決する)だが、なぜ全箇所に掛けるのかが書かれていない。

- [ ] **Step 1: 理由を書く**

`waitForTransitionsSettled` の doc へ 2 行足す:

```ts
/**
 * …既存の説明…
 *
 * 撮影の直前に一律で呼ぶ。必要なのはタブ遷移を挟む数枚だけだが、どの画面がアニメーションを
 * 持つかは実装の変更で動くため、「必要な画面を選ぶ」形にすると選び漏れが撮影のばらつきとして
 * 出る。進行中のアニメーションが無ければ即座に解決するので、一律で呼ぶ費用はほぼ無い。
 */
```

- [ ] **Step 2: Commit**

```bash
pnpm exec biome check --write editor/e2e/capture_docs.spec.ts
git add editor/e2e/capture_docs.spec.ts
git commit -m "docs(e2e): 遷移の収束待ちを全撮影へ一律で掛ける理由を書く"
```

---

### Task 3: e2e 型検査の型定義の在り処を説明する

**Files:**
- Modify: `editor/tsconfig.e2e.json`(`typeRoots` の doc コメント)
- Modify: `editor/README.md`(型検査の説明)

**Interfaces:**
- Consumes: なし。
- Produces: なし。

`typeRoots` が `./server/node_modules/@types` を指しており、`editor/server` が `@types/node` を
持っていることに依存している。壊れれば `TS2688` で明示的に落ちるので危険は小さいが、
なぜそこを指すのか(根へ依存を足すとオフライン配布のバンドル再生成が要る)が 1 箇所にしか無い。

- [ ] **Step 1: tsconfig のコメントを補う**

```jsonc
    // `@types/node` は根にも `editor` にも無く、`editor/server` の依存としてだけ存在する。
    // 根へ足すとオフライン配布のバンドルを作り直すことになるので、ここから借りる。
    // この配置が変わると `TS2688` で明示的に落ちるので、黙って壊れることはない。
    "typeRoots": ["./server/node_modules/@types"]
```

- [ ] **Step 2: README に 1 文足す**

型検査を説明している段落の末尾へ:

```markdown
（`@types/node` は `editor/server` の依存を借りている。根へ足すとオフライン配布のバンドルを
作り直すことになるため。配置が変われば `TS2688` で落ちる。）
```

- [ ] **Step 3: 型検査が通ることを確認する**

Run: `pnpm exec tsc -p editor/tsconfig.e2e.json`
Expected: exit 0。

- [ ] **Step 4: Commit**

```bash
git add editor/tsconfig.e2e.json editor/README.md
git commit -m "docs(editor): e2e 型検査が型定義を借りている理由を tsconfig と README に書く"
```

---

### Task 4: `E2E_REST` のエラー文を規約の幅に収める

**Files:**
- Modify: `editor/playwright.config.ts:18`

**Interfaces:**
- Consumes: なし。
- Produces: なし(文言は同じ、改行位置だけ変わる)。

エラー文の 1 行が 107 桁で、規約の目安 100 桁を超えている。機械検査は無いが、同ファイルの他の行は
すべて収まっている。

- [ ] **Step 1: 2 行へ分ける**

```ts
    throw new Error(
      'project "rest" は E2E_REST=1 のときだけ定義されます。' +
        '呼び出し元のシェルで E2E_REST=1 を設定してから `pnpm run e2e:rest` を実行してください。',
    );
```

文言は変えない(連結で同じ文字列になること)。

- [ ] **Step 2: 発火と素通りを確認する**

Run:
```bash
pnpm exec playwright test -c editor/playwright.config.ts --list --project=chromium
pnpm exec playwright test -c editor/playwright.config.ts --list --project=rest
```
Expected: 1 つ目は spec 一覧が出る(exit 0)。2 つ目は上の文言で落ちる。

- [ ] **Step 3: 型検査**

Run: `pnpm exec tsc -p editor/tsconfig.e2e.json`
Expected: exit 0。

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write editor/playwright.config.ts
git add editor/playwright.config.ts
git commit -m "style(e2e): E2E_REST のエラー文を 2 行に分けて桁幅の目安へ収める"
```

---

### Task 5: 差分採点の前提を 2 箇所へ明記する

**Files:**
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(複合手の `movedIdx` 付近)
- Modify: `pie-chart/src/svg_export/leader_geometry.ts`(`buildScoreBase` の行列確保)

**Interfaces:**
- Consumes: `buildScoreBase(placements, cfg, coord)`。
- Produces: なし(挙動不変。行列の確保位置だけ動く)。

2 件。① 変化 index に `placements` の添字をそのまま使えるのは「この関数が配列を並べ替えない」
ことに依るが、それが書かれていない。② 名前が重複するときも n×n の行列を 2 枚確保してから
戻っており、無駄なうえ「行列を使うのでは」と読める。

- [ ] **Step 1: 添字が有効な理由を書く**

`emit_repair.ts` の `const movedIdx = new Set<number>([i]);` の直前のコメントへ 1 行足す:

```ts
          // `i` をそのまま使えるのは、この関数が `placements` を並べ替えないため
          // (`seamRestore` はフィールドを書き戻すだけで配列の順序を保つ)。
```

同じ理由で `i` を使っている他のサイト(水平シフト・交差対スワップ)にも同趣旨の説明が要るなら、
1 箇所へ書いて他からはそこを指す形にする(重複を増やさない)。

- [ ] **Step 2: 行列の確保を判定の後ろへ移す**

`leader_geometry.ts` の `buildScoreBase`:

```ts
  const geo = collectLeaderGeometry(placements, cfg, coord);
  const n = placements.length;
  // 名前が重複する入力では差分を使わないので、行列は作らない(呼び出し側は `usable` を見て
  // 全走査へ落ちる)。空の行列を返すのは、型を分けずに「使ってはいけない基準」を表すため。
  const usable = new Set(placements.map((p) => p.item.name)).size === n;
  if (!usable) return { geo, crossMat: [], throughMat: [], usable };
  const crossMat = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const throughMat = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  // …既存の 2 重ループ…
```

`crossMat: []` へ変えると型は `boolean[][]` のままで通る。**読み手側が `base.crossMat[i][j]` を
評価する前に必ず `usable` を見る**ことは `measureRepairVecDelta` が保証しているので、空配列でも
落ちない。もし空配列にすると型か実行時に問題が出るなら、確保はそのままにして
コメントだけ足す(挙動不変が最優先)。

- [ ] **Step 3: 確認とバイト不変**

Run: `pnpm exec vitest run --project pie-chart && pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff`
Expected: 全テスト緑、83 件 byte 一致。

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write pie-chart/src/svg_export/emit_repair.ts pie-chart/src/svg_export/leader_geometry.ts
git add pie-chart/src/svg_export/emit_repair.ts pie-chart/src/svg_export/leader_geometry.ts
git commit -m "refactor(pie-chart): 変化 index が有効な理由を書き、差分を使わない入力では行列を作らない"
```

---

### Task 6: 設計書の上限値と語を実態へ揃える

**Files:**
- Modify: `docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md`(§4.3、§5.3)

**Interfaces:**
- Consumes: なし。
- Produces: なし。

2 件。① §5.3 の n=12 の上限 70.8% が、同じ節の数値から計算すると 71.6% になる(達成度も
91.5% でなく 90.5%)。差は leader を描かない配置のぶん対数が理論値を下回ることに由来するが、
その断りが無い。② §4.3 の「同名なら全走査へ落ちる」は**対判定の数え方**の話で、幾何は
`changed` 由来のまま作られる。読み手が「幾何も作り直す」と受け取りうる。

- [ ] **Step 1: 上限値に断りを添える**

§5.3 の表の下、上限を説明している段落へ 2 行足す:

```markdown
上限の計算に使う「採点 1 回あたりの対数」は leader を全件描く場合の値で、実際には leader を
描かない配置があるぶん下回る。表の数値から機械的に計算すると n=12 の上限は 71.6%(達成度
90.5%)になるが、実効の上限はそれよりわずかに低い。いずれにせよ達成度は約 9 割である。
```

数値を 71.6 / 90.5 へ書き換えるのではなく、**両方の見方を示す**(どちらか一方が正しいのではなく、
上限の推定に幅がある)。

- [ ] **Step 2: 「全走査へ落ちる」の射程を書く**

§4.3 の該当箇所へ 1 行足す:

```markdown
落ちるのは**対判定の数え方**だけで、幾何(`geo`)は `changed` から作った差し替え版をそのまま
使う。`changed` が正しければ両者は同値なので、これで値は変わらない。
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md
git commit -m "docs(pie-chart): 差分採点の上限値の幅と「全走査へ落ちる」の射程を書き足す"
```

---

## Self-Review

- **項目の消化**: 撮影の時刻 = Task 1。収束待ちの一律適用 = Task 2。型定義の借用 = Task 3。
  エラー文の桁幅 = Task 4。変化 index の前提と行列の確保 = Task 5。上限値の丸めと「全走査へ
  落ちる」の語 = Task 6。計 7 件。
- **Placeholder scan**: 各 Step に文面とコードがある。Task 5 Step 2 は空配列化が通らない場合の
  代替(コメントのみ)を明記した。
- **挙動不変の担保**: Task 1 は撮影して `git status` が空であること、Task 5 は `batch:diff` で
  確認する。他はコメントと文書のみ。
