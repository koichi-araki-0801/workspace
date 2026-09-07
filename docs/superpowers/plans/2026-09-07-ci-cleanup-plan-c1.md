# CI 最適化 後始末 計画 C1 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI 最適化(計画 A / B1 / B2)が残した 5 種の後始末 — 手引きスクリーンショットの再撮影が
毎回作業ツリーを汚す件、e2e が型検査の外にある件、`e2e:rest` が環境変数なしで意味不明に落ちる件、
`gen_long_14_other` が `gen_long_12_other` と同一入力になっている件、最終レビューが繰り越した
テスト品質 7 件 — を、本番コードに触れずに片付ける。

**Architecture:** 新しい仕組みは足さない。撮影は Playwright の `animations: 'disabled'` と
スピナー待ちで決定的にする。e2e の型検査は `editor/tsconfig.e2e.json` を 1 つ足して既存の
`typecheck` 連鎖に繋ぐ。`e2e:rest` の誤起動は `playwright.config.ts` の中で理由付きの例外にする。
合成ケース生成器は「値が 0 に丸まる直前に残りを均等配分する」分岐を 1 つ足し、n=14 だけが
変わることをハッシュ定数表で固定する。テスト品質は既存テストの主張を強めるだけ。

**Tech Stack:** pnpm 11 / Node 24 / vitest 4.1.11 / @playwright/test 1.62 / TypeScript 6 / Biome 2.4.16

**Spec:** 設計はチャットで承認済み(2026-09-07。分割: C1 = 本計画、C2 = pie-chart 採点の差分計算は
別途 dig → spec → plan)。背景は `docs/superpowers/specs/2026-09-06-ci-optimization-design.md`
(2.2 節の別計画送り、6 章の e2e、10 章の B1 / B2 完了条件)と計画 B1 / B2 の残作業メモ。

## Global Constraints

- **本番コード(`editor/*/src`・`pie-chart/src`)は触らない。** 触るのはテスト・e2e・設定
  (`tsconfig` / `package.json` scripts / `playwright.config.ts`)・テスト helper(`pie-chart/test/helpers`)
  のみ。
- **カバレッジ閾値はファイル単位 4 指標 85%(`perFile: true`)のまま。** include も閾値も触らない。
- **pie-chart の実サンプル出力はバイト不変**: `pnpm --filter pie-chart run batch` →
  `batch:diff` で 83 件一致。合成ケースのハッシュ定数表(`renderHashExpected.ts`)は
  **`gen_long_14_other` の 1 行だけ**が変わる。他 25 行が不変であることは `render_hash.test.ts`
  (24 ケース)と `render_hash_long.test.ts`(`gen_long_12_other`)が自動で固定する。
- **撮影の決定性の受入条件**: `pnpm exec playwright test -c editor/playwright.config.ts --project=docs`
  を 2 回連続で走らせ、`docs/editor/images/*.png` 14 枚の SHA256 が run 間で全部一致する。
- **e2e の flake を増やさない**: `retries: 0` のまま。固定待ち(`waitForTimeout`)は足さない。
- **コメント規約**(`docs/コメント規約.md`): 装飾ボックス、「なぜ」、経緯(日付・所見番号)は書かない。
  ドキュメントは通常の日本語。
- **コミット前に `pnpm exec biome check --write <変更ファイル>`**(editor 配下は lint-staged が
  ステージを入れ替える事故を避ける)。コミットメッセージは日本語、末尾に
  `Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF`。
- **同一 checkout で別セッションが作業していることがある。** `git add` は明示ファイルのみ
  (`-A` 禁止)。作業ツリーの見知らぬ untracked / modified には触らない。
- **重いジョブは重ねない**: 全体 `pnpm run ci` / `test:coverage` / e2e は、直前のコミットの
  pre-push CI(`Get-CimInstance Win32_Process` で `ci-affected` / `vitest` / `playwright` を確認)が
  終わってから走らせる。同じ `coverage/` を書くと「Something removed the coverage directory」で
  落ちる。

---

### Task 1: 手引きスクリーンショットの決定性

**Files:**
- Modify: `editor/e2e/helpers.ts:37-46`(`waitForLoaded`)
- Modify: `editor/e2e/capture_docs.spec.ts`(`screenshot(` 呼び出し 12 箇所すべて)
- Modify: `docs/editor/images/*.png`(再撮影の結果。差分が出た枚だけ)

**Interfaces:**
- Consumes: `waitForLoaded(page)`(既存。`.animate-pulse` が 0 件になるまで待つ)。
- Produces: `waitForLoaded` が `.animate-spin` も 0 件になるまで待つ。撮影はすべて
  `animations: 'disabled'`。

背景: run 間で変わるのは `create-tab.png`(版種セレクト横のローディングスピナーの回転角)と
`history-tab.png`(タブ切替のトランジション途中)の 2 枚(2026-09-07 の実測)。どちらも CSS
アニメーションの位相であり、内容の違いではない。Playwright の `animations: 'disabled'` は有限の
アニメーションを終端へ進め、無限のアニメーション(スピナー)を止める。

- [ ] **Step 1: `waitForLoaded` をスピナーも待つ形にする**

```ts
/**
 * ロード中の表示が消えるまで待つ。`animate-pulse` を持つのは `Skeleton.vue` だけ、
 * `animate-spin` を持つのは各画面のローディングスピナーだけなので、両方 0 件 = 実データの
 * 描画完了。**画面遷移直後にそのまま呼ぶと、スケルトンがまだ 1 度も描画されていない瞬間を
 * 「0 件 = 完了」と誤認しうる**(`useAsyncResult` の `loading` は参照カウント式で初期値 false、
 * スケルトン表示は `onMounted` の非同期処理が実際に走ってから)。その画面固有の実データ要素を
 * 先に待ってから呼ぶこと(呼び出し側の責務)。
 */
export async function waitForLoaded(page: Page): Promise<void> {
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.animate-spin')).toHaveCount(0, { timeout: 15_000 });
}
```

- [ ] **Step 2: 全 `screenshot(` に `animations: 'disabled'` を付ける**

`capture_docs.spec.ts` の `page.screenshot({ path: IMG('…') })` と要素の `.screenshot({ path: … })`
すべてに `animations: 'disabled'` を加える。1 箇所の例:

```ts
  await page.screenshot({ path: IMG('create-tab.png'), animations: 'disabled' });
```

ファイル冒頭のコメントに理由を 2 行足す: 「撮影は `animations: 'disabled'` で行う。スピナーの
回転角やタブ切替のトランジション途中が写ると、内容が同じでもバイト列が run ごとに変わり、
pre-push の再撮影が毎回作業ツリーを汚す。」

- [ ] **Step 3: 2 回連続で撮影して run 間の一致を確認する**

Run(ポートが空いていること: `node scripts/check-ports.mjs 24680 24681`):
```bash
pnpm exec playwright test -c editor/playwright.config.ts --project=docs
mkdir -p .tmp/cap1 && cp docs/editor/images/*.png .tmp/cap1/
pnpm exec playwright test -c editor/playwright.config.ts --project=docs
for f in .tmp/cap1/*.png; do b=$(basename "$f"); [ "$(sha256sum "$f" | cut -c1-16)" = "$(sha256sum "docs/editor/images/$b" | cut -c1-16)" ] && echo "same $b" || echo "DIFF $b"; done
rm -rf .tmp/cap1
```
Expected: 14 行すべて `same`。`DIFF` が残る枚があれば、その画面で動いている要素(スピナー以外の
`animate-*` クラス、`transition` 付きの要素)を特定し、`waitForLoaded` へ待ち条件を足す
(固定待ちは足さない)。

- [ ] **Step 4: 再撮影で変わった PNG を確認して Commit**

`git status --short docs/editor/images/` で差分が出た枚は、内容が変わった正当な再撮影
(比較画面のページ対応入力など、直近の画面変更)なので一緒にコミットする。

```bash
pnpm exec biome check --write editor/e2e/helpers.ts editor/e2e/capture_docs.spec.ts
git add editor/e2e/helpers.ts editor/e2e/capture_docs.spec.ts docs/editor/images/
git commit -m "test(e2e): 手引きの撮影をアニメーション停止とスピナー待ちで決定的にし、画面を再撮影する"
```

- [ ] **Step 5: 手引き HTML を作り直す**

画像が変わったので `py -3.13 docs/_build/build_all.py --project editor` を実行し、生成された
`docs/editor/editor_手引き.html` / `docs/editor/editor_設計.html` をコミットする(CLAUDE.md
「editor のスクリーンショット再撮影後は build_all の再実行が必要」)。

```bash
py -3.13 docs/_build/build_all.py --project editor
git add docs/editor/editor_手引き.html docs/editor/editor_設計.html
git commit -m "docs(editor): 再撮影した画面で手引きと設計書の HTML を作り直す"
```

---

### Task 2: e2e と Playwright 設定を型検査に入れる

**Files:**
- Create: `editor/tsconfig.e2e.json`
- Modify: `package.json`(`typecheck` / `typecheck:editor`)
- Modify: `editor/e2e/*.ts`・`editor/playwright.config.ts`(型エラーが出た箇所の修正のみ)
- Modify: `editor/README.md`(型検査の説明に 1 文)

**Interfaces:**
- Produces: `tsc -p editor/tsconfig.e2e.json` が exit 0。`pnpm run typecheck` /
  `typecheck:editor` がこれを含む。

- [ ] **Step 1: `editor/tsconfig.e2e.json` を書く**

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    // e2e と Playwright 設定の型検査だけが目的。emit はしない。
    "noEmit": true,
    "declaration": false,
    "sourceMap": false,
    // `./helpers` のような拡張子なしの相対 import は Playwright(esbuild)が解決する。
    // 実行時の解決規則に合わせて Bundler にする(NodeNext だと `.js` 拡張子を要求される)。
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"]
  },
  "include": ["e2e/**/*.ts", "playwright.config.ts"]
}
```

`editor/tsconfig.base.json` は `lib` に `DOM` を含むので、`page.evaluate` 内の DOM 参照は通る。

- [ ] **Step 2: 実行して型エラーを確認する**

Run: `pnpm exec tsc -p editor/tsconfig.e2e.json`
Expected: 初回は型エラーが出うる(`any` の暗黙、`page.evaluate` の戻り型、未使用変数など)。
出たエラーは **e2e 側のコードで** 直す(`as` の乱用はせず、型注釈か `satisfies` で)。
`editor/e2e/_tmp/` に一時ファイルがあれば include から外れるよう `"exclude": ["e2e/_tmp/**"]` を
足す。

- [ ] **Step 3: `package.json` の typecheck に繋ぐ**

```json
    "typecheck": "tsc -b editor/server && tsc -p editor/server/tsconfig.tools.json && tsc -p editor/tsconfig.e2e.json && pnpm --filter web --filter pie-chart run typecheck",
    "typecheck:editor": "tsc -b editor/server && tsc -p editor/server/tsconfig.tools.json && tsc -p editor/tsconfig.e2e.json && pnpm --filter web run typecheck",
```

Run: `pnpm run typecheck`
Expected: exit 0。

- [ ] **Step 4: README に 1 文足す**

`editor/README.md` の型検査を説明している箇所(「`@editor/shared` の先行ビルドが前提」の近く)に
「e2e(`editor/e2e/**`)と `playwright.config.ts` は `editor/tsconfig.e2e.json`(`noEmit`・
`moduleResolution: Bundler`)で検査する。」を足す。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write editor/e2e editor/playwright.config.ts
git add editor/tsconfig.e2e.json package.json editor/README.md editor/e2e editor/playwright.config.ts
git commit -m "chore(editor): e2e と Playwright 設定を tsconfig.e2e.json で型検査に入れる"
```

---

### Task 3: `e2e:rest` の誤起動を理由付きで止める

**Files:**
- Modify: `editor/playwright.config.ts:8`(`REST` の直後)
- Test: 手動(環境変数なしで実行して文言を確認)

**Interfaces:**
- Produces: `E2E_REST` 未設定で `--project rest` / `--project=rest` を指定すると、
  「E2E_REST=1 を呼び出し元のシェルで設定してから `pnpm run e2e:rest` を実行してください」で
  即終了する(Playwright の "Project(s) "rest" not found" ではなく)。

- [ ] **Step 1: 設定の読み込み時に検査する**

`const REST = process.env.E2E_REST === '1';` の直後に:

```ts
// `rest` project は `E2E_REST=1` のときだけ定義される。未設定のまま `--project rest` を指定すると
// Playwright は "Project(s) \"rest\" not found" としか言わず、環境変数の存在に気づけない。
// 設定の読み込み時点で理由を言って止める。
const wantsRest = process.argv.some((a, i, argv) =>
  a === '--project=rest' || (a === '--project' && argv[i + 1] === 'rest'),
);
if (wantsRest && !REST) {
  throw new Error(
    'project "rest" は E2E_REST=1 のときだけ定義されます。呼び出し元のシェルで E2E_REST=1 を設定してから `pnpm run e2e:rest` を実行してください。',
  );
}
```

- [ ] **Step 2: 手動で確認する**

Run(環境変数なし): `pnpm run e2e:rest`
Expected: 上の文言を含むエラーで終了(exit 1)。
Run(設定あり、PowerShell): `$env:E2E_REST='1'; pnpm run e2e:rest`
Expected: 従来どおり rest project が走る(2 spec 緑)。終わったら `Remove-Item Env:E2E_REST`。

- [ ] **Step 3: Commit**

```bash
pnpm exec biome check --write editor/playwright.config.ts
git add editor/playwright.config.ts
git commit -m "test(e2e): E2E_REST 未設定で rest project を指定したときに理由を言って止める"
```

---

### Task 4: `gen_long_14_other` を n=12 と別の入力にする

**Files:**
- Modify: `pie-chart/test/helpers/syntheticCases.ts:52-65`(`makeItems`)、`:100-106`(コメント)
- Modify: `pie-chart/test/helpers/renderHashExpected.ts:17`(`gen_long_14_other` の 1 行)
- Modify: `pie-chart/test/render_hash_long.test.ts:7-10`(コメント)
- Test: `pie-chart/test/synthetic_cases.test.ts`(新規)

**Interfaces:**
- Consumes: `makeItems(n, style, withOther)`(module 内部)、`syntheticCases()`、`EXPECTED`。
- Produces: `syntheticCases().gen_long_14_other` が 14 項目すべて `value > 0`。他のケースの
  項目列は不変。

現状: 逓減列 `value = round(remaining * 0.45, 1)` は `remaining < 0.12` になると 0.0 に丸まり、
n=14 の末尾 2 項目が 0 になる。正規化(`|value| > 0` フィルタ)で落ちて n=12 と同一入力になる。
n ≤ 12 では 0 に丸まる項目が無い(そのため n ≤ 12 のハッシュは動かない)。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// =============================================================================
// synthetic_cases.test.ts — 合成ケース生成器の不変則
// =============================================================================
// ハッシュ定数表はケースごとの出力を固定するが、「ケースが互いに別の入力である」ことは
// 固定しない。n=14 が末尾の 0 で n=12 と同一入力に潰れていた穴を、生成器の性質として固定する。
import { describe, expect, it } from 'vitest';
import { syntheticCases } from './helpers/syntheticCases.js';

describe('syntheticCases', () => {
  it('どのケースも値 0 の項目を持たない(正規化で項目が落ちて別ケースと同一入力にならない)', () => {
    for (const [name, items] of Object.entries(syntheticCases())) {
      expect(items.every((i) => i.value > 0), name).toBe(true);
    }
  });

  it('gen_long_14_other は 14 項目で、gen_long_12_other とは異なる入力', () => {
    const cases = syntheticCases();
    expect(cases.gen_long_14_other).toHaveLength(14);
    expect(cases.gen_long_14_other).not.toEqual(cases.gen_long_12_other);
  });

  it('各ケースの値の合計は 100', () => {
    for (const [name, items] of Object.entries(syntheticCases())) {
      const sum = Math.round(items.reduce((s, i) => s + i.value, 0) * 10) / 10;
      expect(sum, name).toBe(100);
    }
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/synthetic_cases.test.ts`
Expected: 1 つ目が `gen_long_14_other` で FAIL(値 0 の項目がある)。

- [ ] **Step 3: `makeItems` を直す**

```ts
function makeItems(n: number, style: 'short' | 'long', withOther: boolean): Slice[] {
  const names = style === 'short' ? SHORT_NAMES : LONG_NAMES;
  const items: Slice[] = [];
  let remaining = 100;
  for (let i = 0; i < n; i += 1) {
    const left = n - i;
    // 先頭は残りの 45%、以降も残りの 45% ずつ取る逓減列。末尾は残り全部 (合計 100)。
    // 残りが小さくなり 45% が 0.1 未満に丸まる手前では、残りの項目へ 0.1 刻みで均等に配る
    // (値 0 の項目は正規化で落ちて別ケースと同一入力になるため作らない)。
    const decayed = Math.round(remaining * 0.45 * 10) / 10;
    const even = Math.round((remaining / left) * 10) / 10;
    const value = i === n - 1 ? remaining : decayed >= 0.1 && decayed < remaining ? decayed : even;
    items.push({ name: names[i % names.length], value: Math.round(value * 10) / 10 });
    remaining = Math.round((remaining - value) * 10) / 10;
  }
  if (withOther) items[n - 1] = { ...items[n - 1], name: 'その他' };
  return items;
}
```

n ≤ 12 では `decayed >= 0.1` が常に成り立つ(既存の値列と同一)ことを Step 5 のハッシュ不変が
証明する。n=14 で `even` が 0.1 未満になることは無い(残り 0.2 を 2 項目へ配る形が最悪)。

- [ ] **Step 4: 新テストが通ることを確認する**

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/synthetic_cases.test.ts`
Expected: 3 件 PASS。

- [ ] **Step 5: ハッシュを更新し、n ≤ 12 が不変であることを確認する**

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/render_hash.test.ts pie-chart/test/render_hash_long.test.ts --reporter=verbose 2>&1 | grep -E "✓|✗|×|Expected|Received"`
Expected: `gen_long_14_other` だけが FAIL し、`Received` に新しい SHA256 が出る。他 25 件は PASS。
その値を `renderHashExpected.ts:17` へ書き、再実行して 26 件 PASS。

コメントの更新:
- `renderHashExpected.ts` のファイル冒頭コメントは変えない(「値の更新は挙動変更を意図した時だけ」
  の実例がこの変更)。
- `syntheticCases.ts:100-106` の docstring から「`gen_long_14_other` は正規化で値 0 の 2 項目が
  落ちて…同じ」の 2 文を削り、「n=14 は逓減の末尾を均等配分で埋めた 14 項目」に置き換える。
- `render_hash_long.test.ts:7-10` の同趣旨の 4 行を削る。

- [ ] **Step 6: バイト不変と Commit**

Run: `pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff`
Expected: 83 件一致(合成ケースは実サンプルの出力に無関係だが、規約どおり回す)。

```bash
pnpm exec biome check --write pie-chart/test
git add pie-chart/test/helpers/syntheticCases.ts pie-chart/test/helpers/renderHashExpected.ts pie-chart/test/render_hash_long.test.ts pie-chart/test/synthetic_cases.test.ts
git commit -m "test(pie-chart): 合成ケース n=14 の末尾を均等配分にして n=12 と別の入力にし、ハッシュを更新する"
```

---

### Task 5: 繰り越したテスト品質 7 件

**Files:**
- Modify: `editor/server/test/egressGuard.test.ts:418-458`
- Modify: `editor/web/test/restHttp.dom.test.ts:76-90`
- Modify: `editor/server/test/gitRepo.test.ts:166-175`
- Modify: `editor/server/test/templates.routes.test.ts:123-133`
- Modify: `editor/server/test/generate.routes.local.test.ts:84`
- Modify: `editor/web/test/fillJinja.dom.test.ts:254-259`
- Modify: `pie-chart/test/sea_runtime.test.ts:155-197`

**Interfaces:**
- Consumes: 各ファイルの既存 helper(`startFakeBuild` / `stopFakeBuild`、`setUnauthorizedHandler`、
  `git.commitAll`、`stubSeaRequire` / `freshRuntime`)。
- Produces: なし(主張の強化のみ)。

- [ ] **Step 1: egressGuard — 「ハングしない」を実際に検査する**

`outcome` の `Error('client timeout')` を専用センチネルにし、それが結果でないことを主張する:

```ts
    const CLIENT_TIMEOUT = Symbol('client timeout');
    const outcome = await new Promise<{ status: number } | Error | typeof CLIENT_TIMEOUT>((resolve) => {
      // …(既存の request 組み立てはそのまま)…
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(CLIENT_TIMEOUT);
      });
      req.end();
    });
    // 上流が切れた事実は「200 のまま打ち切られる」か「client 側のエラー」として現れる。
    // client 側の timeout に落ちたら中継がハングしている。
    expect(outcome).not.toBe(CLIENT_TIMEOUT);
    expect(outcome instanceof Error || (outcome as { status: number }).status === 200).toBe(true);
```

Run: `pnpm exec vitest run --project server editor/server/test/egressGuard.test.ts`

- [ ] **Step 2: restHttp — セッション切れハンドラをファイル全域の afterEach で戻す**

```ts
afterEach(() => {
  vi.unstubAllGlobals();
  // ハンドラはモジュール全域の state。途中で assert が落ちても後続テストへ漏らさない。
  setUnauthorizedHandler(null);
});
```

テスト本文末尾の `setUnauthorizedHandler(null);` は削る。

Run: `pnpm exec vitest run --project web-dom editor/web/test/restHttp.dom.test.ts`

- [ ] **Step 3: gitRepo — index.lock の解放を「1 回目の再試行を観測してから」にする**

実時間の 300ms ではなく、lock ファイルへの 2 回目のアクセス(= 1 回目のリトライ)を観測してから
外す。git が index.lock を開こうとして失敗する回数は外から数えられないので、`commitAll` が
待っている間に lock を外す時点を「最初のリトライ待ち(200ms)が確実に始まった後」へ寄せつつ、
上限は commit の完了で決める形にする:

```ts
  it('index.lock が居る間は待ち、外れれば commit が通る(共有違反リトライ)', async () => {
    const rel = 'templates/AM01_999999_20250110_交付版.html';
    fs.writeFileSync(path.join(tmp, rel), '<p>lock retry</p>', 'utf8');
    const lockFile = path.join(tmp, '.git', 'index.lock');
    fs.writeFileSync(lockFile, '');
    const started = Date.now();
    const commit = git.commitAll('確定保存: lock retry', { name: 'tester' });
    // lock を握っている間は commit が完了しないことを先に確かめてから外す
    // (実時間の窓に賭けず、「待っている」事実を観測してから解放する)。
    await new Promise((r) => setTimeout(r, 250));
    let settled = false;
    void commit.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    fs.rmSync(lockFile, { force: true });
    const hash = await commit;
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  }, 10_000);
```

Run: `pnpm exec vitest run --project server editor/server/test/gitRepo.test.ts`

- [ ] **Step 4: templates.routes — コメントの訂正**

`:124-125` のコメントを「`?companyCode=a&companyCode=b` は Fastify のクエリ解析で配列になる。
`toQuery` は文字列でない値を無視するので、配列で来た絞り込みは効かず候補は全件になる(同名
キーの重複で絞り込みが黙って変わらないことの固定)。」へ置き換える(被覆の理由付けを外す)。

- [ ] **Step 5: generate.routes.local — 非弁別の主張を置き換える**

`:84` の `expect(fs.readdirSync(templatesDir)).toEqual([]);` を削り、代わりに local モードでは
`writePending` が呼ばれない事実を主張する(`pendingDir` の空は既に主張済み)ので、行ごと削除で
よい。コメントに「確定領域(`templatesDir`)へ書かないことは `generate.routes.test.ts` が
認証オンで主張する。ここは local の非到達(台帳・pending)だけを見る。」を残す。

- [ ] **Step 6: fillJinja — 要素数で主張する**

```ts
  it('for の対象が配列でなければ 0 回展開(例外にしない)', () => {
    const out = toFilled('<ul>{% for h in holdings %}<li>{{ h.name }}</li>{% endfor %}</ul>', {
      holdings: 7,
    });
    const doc = new DOMParser().parseFromString(out, 'text/html');
    // 反復本体は残る(round-trip 用のマーカー付き雛形)が、値入りの行は 1 つも増えない。
    expect(doc.querySelectorAll('li').length).toBeLessThanOrEqual(1);
    expect(out).not.toContain('h.name');
    expect(doc.body.textContent?.trim()).toBe('');
  });
```

実装の出力(雛形 `<li>` が 1 つ残るか 0 か)を確認し、`toBeLessThanOrEqual(1)` は実際の数に
合わせて `toBe(0)` か `toBe(1)` の厳密な主張へ置き換える。

- [ ] **Step 7: sea_runtime — afterEach のスコープと 1 it 3 主張の分割**

ファイル全域の `afterEach`(`:158-161`)を `describe('SEA 実行時の経路', …)` の中へ移す
(`Module._resolveFilename の封鎖` の describe は既に `try/finally` で自己復元している)。
「installSeaGuards が解決封鎖を張り、2 度目は何もしない」を 3 つに分ける:

```ts
  it('SEA では installSeaGuards が builtin 以外の解決を封鎖する', async () => {
    stubSeaRequire({ isSea: () => true, getAsset: () => new ArrayBuffer(0) });
    const rt = await freshRuntime();
    rt.installSeaGuards();
    expect(() => (internals._resolveFilename as (r: string) => string)('lodash')).toThrow(
      /external module resolution is disabled/,
    );
  });

  it('封鎖の後も builtin は解決できる', async () => {
    stubSeaRequire({ isSea: () => true, getAsset: () => new ArrayBuffer(0) });
    const rt = await freshRuntime();
    rt.installSeaGuards();
    expect(() => (internals._resolveFilename as (r: string) => string)('node:path')).not.toThrow(
      /disabled/,
    );
  });

  it('installSeaGuards の 2 度目は何もしない(封鎖を二重に張らない)', async () => {
    stubSeaRequire({ isSea: () => true, getAsset: () => new ArrayBuffer(0) });
    const rt = await freshRuntime();
    rt.installSeaGuards();
    const before = internals._resolveFilename;
    rt.installSeaGuards();
    expect(internals._resolveFilename).toBe(before);
  });
```

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/sea_runtime.test.ts`

- [ ] **Step 8: 7 ファイルの focused run と perFile 計測**

Run:
```bash
pnpm exec vitest run --project server editor/server/test/egressGuard.test.ts editor/server/test/gitRepo.test.ts editor/server/test/templates.routes.test.ts editor/server/test/generate.routes.local.test.ts
pnpm exec vitest run --project web-dom editor/web/test/restHttp.dom.test.ts editor/web/test/fillJinja.dom.test.ts
pnpm exec vitest run --project pie-chart pie-chart/test/sea_runtime.test.ts
```
Expected: 全緑。被覆は主張の強化なので下がらない(疑わしければ該当ファイルを
`--coverage.include` に絞って `--coverage.thresholds.perFile=true` で確認)。

- [ ] **Step 9: Commit**

```bash
pnpm exec biome check --write editor/server/test editor/web/test pie-chart/test
git add editor/server/test/egressGuard.test.ts editor/web/test/restHttp.dom.test.ts editor/server/test/gitRepo.test.ts editor/server/test/templates.routes.test.ts editor/server/test/generate.routes.local.test.ts editor/web/test/fillJinja.dom.test.ts pie-chart/test/sea_runtime.test.ts
git commit -m "test: 繰り越したテスト品質 7 件(ハング検査・ハンドラ復元・lock 解放の観測・主張の厳密化・スコープ)を直す"
```

---

### Task 6: 全体の通し

**Files:** なし(検証のみ)。

- [ ] **Step 1: 空きマシンで `pnpm run ci` を 1 回**

直前のコミットの pre-push CI が終わっていることを確認してから:
```bash
pnpm run ci
```
Expected: exit 0(`check:comments → check:claude-hooks → check:ci → test:scripts → typecheck →
test:coverage → test:docs → pie-chart:batch → pie-chart:batch:diff → build → test:e2e`)。
`typecheck` に e2e が含まれ、`test:coverage` は perFile で ERROR 0、e2e は 36 件緑。所要秒数を
報告に書く(計画 A の実測 236s と比べる)。

- [ ] **Step 2: 作業ツリーが clean であることを確認する**

`git status --short` が空(pre-push の再撮影で PNG が変わっていないこと = Task 1 の効果)。

---

## Self-Review

- **Spec coverage**: チャットで承認した 5 項目(撮影の決定性 / e2e 型検査 / e2e:rest / gen_long_14 /
  テスト品質 7 件)= Task 1〜5。検証 = Task 6。pre-push に撮影を残す・7 件全部やる、はユーザーの
  選択どおり。
- **Placeholder scan**: 各 Step にコードと期待結果がある。Task 5 Step 6 の `toBeLessThanOrEqual(1)`
  は実出力を見て厳密化する指示付き。Task 2 Step 2 の型エラー修正は内容が実行時にしか分からない
  ため「e2e 側で直す・`as` 乱用禁止」の方針で縛る。
- **Type consistency**: `waitForLoaded(page)` の名前・引数は既存と一致。`CLIENT_TIMEOUT` は
  Task 5 Step 1 内で定義と利用が閉じる。`makeItems` の引数は既存と同一。
- **本番コード不変**: 変更対象は e2e / テスト / helper / tsconfig / package.json scripts /
  playwright.config.ts / docs のみ。
