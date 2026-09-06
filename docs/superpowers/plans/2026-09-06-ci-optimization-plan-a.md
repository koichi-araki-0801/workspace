# CI 最適化 計画 A(CI の速度と構造)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** フル `pnpm run ci` の臨界経路(pie-chart の `render_hash` 1 テスト)を分割と byte 不変の
高速化で縮め、CI スクリプト 3 系統(`ci` / `ci-affected` / `ci.yml`)の検査抜けと手同期を機械検査で
閉じ、web の vitest を DOM 依存テストだけ jsdom で走らせ、docs 画像の再撮影を通常 CI から分離する。

**Architecture:** pie-chart は `measureRepairVec` の leader 幾何と box の巻き上げ(計算順序のみ変更、
SVG バイト不変)を段階的に入れ、各段で `batch:diff` と 3 つのゴールデンで固定する。CI スクリプトは
`ci-affected.mjs` の領域判定を純関数へ切り出して `node:test` で固定し、`ci.yml` の段が `ci` の段の
部分列であることを同じテストで検査する。vitest は web の leaf config 2 本をルートへ直接列挙する
(vitest 4.1.11 は参照 config 内のネスト projects を無視する)。playwright は `chromium` / `docs` の
2 project に分け、`ci` と GH は `chromium` だけを走らせる。

**Tech Stack:** pnpm 11 / Node 24 / vitest 4.1.11 / @playwright/test 1.62 / node:test / TypeScript 6 /
GitHub Actions(ubuntu-latest、アクションは SHA pin)

**Spec:** `docs/superpowers/specs/2026-09-06-ci-optimization-design.md`(0〜5 章、6.1 の `docs` project、
9 章、10 章)。前段の決定記録は `docs/superpowers/specs/2026-09-06-ci-optimization-dig.md`。

## Global Constraints

- **SVG 出力はバイト不変**: pie-chart を触るタスクはすべて `npm run batch` → `npm run batch:diff`
  (`pie-chart/README.md` 検証節)で `out/_baseline` と一致すること、および `render_hash`(定数表)/
  `final_score` / `mark_flags` のゴールデンが不変であることを完了条件に含める。`vitest -u` は
  使わない。
- **モジュールグローバルのメモを新設しない**(既存の `LINE_EM_CACHE` はそのまま)。反復中に
  placement を動かす関数(`iterateOverlapPairs`)は巻き上げの対象にしない。早期打ち切りは採らない。
  `EMIT_REPAIR_PASSES` の順序・stage には触れない。
- **受入(pie-chart)**: `gen_long_12_other` 単独 5 秒以下、`render_hash.test.ts`(24 ケース)単独
  30 秒以下。未達なら 2 章の残段を別計画へ切り出し、本計画の他タスクは完了とする。
- **`maxWorkers: 4` は緩めない**(ルート `vitest.config.ts`。8GB の実機で「偽の赤」になる)。
- **`ci` / `runFullCi` / `ci.yml` は同じ段構成**。ずれは `scripts/ci-affected.test.mjs` の機械検査で
  赤にする(手同期へ戻さない)。免除は理由付きで列挙する。
- **`out/_baseline` は git 管理外**。`pnpm run ci` の前に、コミット済みのクリーンな状態で
  `baseline:accept` を 1 回打つ(README に書く)。GH には batch 系を置かない。
- **コメントは `docs/コメント規約.md`** に従う(なぜを書く / 日本語散文 + 英語ドメイン用語 / 経緯・
  日付・所見番号は書かない)。
- **`editor/**` を変更したコミットの前に** `pnpm exec biome check --write editor/<対象>` を先行実行する
  (lint-staged のステージ入れ替わり事故の回避。対象は変更ファイルに限定)。
- **新規スクリプトは増やさない方針**(チームは Python 主力。既存 `scripts/*.mjs` の改修は可)。
  やむを得ず足す場合は node:test のテストを `test:scripts` に登録する。
- **コミットは小さく**(タスクごと)。コミットメッセージは日本語の conventional commit
  (`git log --oneline -15` の形式)。push は auto-push フックが行う。pre-push は `ci:affected` を走らせる。
- **計測は並走負荷なしで行う**。`netstat -ano | findstr ":2468"` で 24680 / 24681 が空いていること、
  他の vitest / playwright プロセスが無いことを確認してから測る。

---
## タスクの順序と依存

| 順 | タスク | 依存 | 効果 |
|---|---|---|---|
| 1 | A1 cold 計測(変更前の基準値) | なし | 設計 0 章の表を埋める |
| 2 | A2 `render_hash` 分割 + 定数表 | なし | 臨界経路 242s → long 1 本 + 24 ケース並列 |
| 3 | P1 web vitest を `web-dom` / `web-node` へ | なし | jsdom 起動費を DOM 依存分だけに |
| 4 | P2 playwright `docs` project + `test:e2e` / `e2e:editor` の `--project` | なし | `ci` / GH から撮影を外す |
| 5 | C1 `ci` の段順序 + `build:editor` 別名 | P2(`--project` の行は P2 が持つ) | `test:docs` / batch 系を `ci` へ |
| 6 | C2 `ci-affected.mjs` 領域判定の純関数化 + BENIGN_FILES + `ci-machinery` | なし | README 単独変更の過剰 CI を止め、`scripts/` を明示 |
| 7 | C3 + C4 yml ⊆ ci の機械検査 + `ci.yml` 並べ替え・concurrency・timeout・cache(同一コミット) | C1 | 手同期の廃止 |
| 8 | C5 `test:e2e` 前のポート検査 | P2(同じ 1 行を触る。合成規則は C の前提節) | 残留 dev サーバの再利用を防ぐ |
| 9 | C6 README に `baseline:accept` の前提 | C1 | clone 直後のフル `ci` が落ちる理由を書く |
| 10 | A7 `hostGuard.test.ts` の timeout | なし | 負荷下の偽の赤を止める |
| 11 | A3 呼出回数カウンタ + 計測スクリプト | A2 | 熱源の回数を数値で持つ |
| 12 | A4 `measureRepairVec` の巻き上げ | A3 | 受入(5 秒)の本命 |
| 13 | A5 / A6(条件付き) | A4 で未達のとき | 段 3 / 段 4 |
| 14 | A8(条件付き) `render_hash_long` の timeout を 60 秒へ | 受入達成後 | |
| 15 | A9 最終検証(cold 計測・設計 0 章 / 10 章の更新) | 全部 | 完了判定 |

P 系列と C 系列はどちらもルート `package.json` を触る。P2 → C1 → C5 の順に入れ、`test:e2e` の 1 行は
「先頭 = ポート検査、末尾 = `--project chromium`」で合成する(C の前提節に同じ規則)。

---

### Task A1: cold の `pnpm run ci` 壁時計を測り、設計 0 章の表へ書く

**Files:**
- Modify: `docs/superpowers/specs/2026-09-06-ci-optimization-design.md`(0 章の表 14〜22 行目に行を追加、
  24〜25 行目の段落を置換、10 章 438〜441 行目に実測値を追記)

**Interfaces:**
- Consumes: ルート `package.json` の `ci`(`check:comments → check:claude-hooks → check:ci → test:scripts →
  typecheck → test:coverage → build → test:e2e`)、`editor/playwright.config.ts` の webServer
  (`reuseExistingServer` のため 24680 / 24681 が空いていることが cold の条件)。
- Produces: 0 章の表の 1 行(壁時計の秒数と条件)。以後の「10 分未満」判定の基準値。

- [ ] **Step 1: 並走負荷が無いことを確認する**

```powershell
# 24680(server) / 24681(vite) が空いていること。何も表示されず exit 1 なら空き。
netstat -ano | findstr ":24680 :24681"

# vitest / playwright の残骸が無いこと。表示されるのが本セッションの CLI(node.exe 1 本)だけならよい。
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime
```

ポートが塞がっていれば `editor/start.bat` 由来の残骸なので `Get-NetTCPConnection -LocalPort 24680,24681
-State Listen` で PID を取り、自分のものだけ `taskkill /PID <pid> /T /F` で止める。他人のプロセスなら
測らない(値が汚れる)。

- [ ] **Step 2: 1 本通して壁時計を取る**

所要は 10 分前後で Bash ツールの上限(600 秒)に掛かるため、`run_in_background` で起動するか、
ユーザーの端末で実行してもらう。PowerShell 5.1 ではネイティブ exe の `2>&1` が NativeCommandError に
化けるので `cmd /c` でリダイレクトする。

```powershell
$sw = [Diagnostics.Stopwatch]::StartNew()
cmd /c "pnpm run ci > %TEMP%\ci-cold.log 2>&1"
$sw.Stop()
"wall=$([int]$sw.Elapsed.TotalSeconds)s exit=$LASTEXITCODE"
```

期待: `exit=0`。`wall=` の秒数を控える。ログから段ごとの参考値も拾える
(`Select-String -Path $env:TEMP\ci-cold.log -Pattern 'Duration|passed \(|Running \d+ tests'`)。
`exit` が非 0 のときは**値を書かず**、落ちた段を 10.1 の flaky 要因(hostGuard の timeout 等)と
突き合わせてから測り直す。

- [ ] **Step 3: 設計書 0 章へ書く**

表の最終行(22 行目 `| e2e(35 件、4 workers) | 72s | ... |`)の直後に 1 行足す(`<NNN>` は Step 2 の値):

```markdown
| `pnpm run ci`(cold・全段の壁時計) | <NNN>s | dev サーバ未起動・並走負荷なし。段の合算(約 6.5 分)との差は e2e の webServer 起動と coverage の集計 |
```

24〜25 行目の段落を置換する:

```markdown
段の合算は約 6.5 分。cold(dev サーバ未起動)で 1 本通した壁時計は上表の最終行(計画 A の最初の
タスクで計測。10 章)。
```

10 章 438〜441 行目の箇条書き末尾に追記する:

```markdown
  分割だけでも 10 分は下回る見込み。→ 実測 <NNN>s(0 章の表)。
```

- [ ] **Step 4: コミット**

```powershell
git add docs/superpowers/specs/2026-09-06-ci-optimization-design.md
git commit -m "docs(superpowers): CI 最適化設計の実測表へ cold の pnpm run ci 壁時計を足す

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---

### Task A2: `render_hash` を 2 ファイルへ分け、期待値を定数表にする(設計 3 章)

**Files:**
- Create: `pie-chart/test/helpers/syntheticCases.ts`(現行 `render_hash.test.ts` 15〜110 行目の
  `SHORT_NAMES` / `LONG_NAMES` / `Slice` / `makeItems` / `syntheticCases` を**そのまま**移す + `LONG_CASE_NAMES`)
- Create: `pie-chart/test/helpers/renderHashExpected.ts`(現行 `.snap` の 26 エントリ)
- Modify: `pie-chart/test/render_hash.test.ts`(全面書き換え。24 ケース × `it.each`)
- Create: `pie-chart/test/render_hash_long.test.ts`(2 ケース)
- Delete: `pie-chart/test/__snapshots__/render_hash.test.ts.snap`

**Interfaces:**
- Consumes: `renderPdfStylePieToSvg(items, {})`(`src/svg_export/pipeline.ts`)。正規化で `|value| > 0` の
  項目だけが残る(`gen_long_14_other` が `gen_long_12_other` と同一入力になる根拠)。
- Produces: `syntheticCases(): Record<string, Slice[]>`、`LONG_CASE_NAMES`、`EXPECTED: Record<ケース名, SHA256>`。
  A3 の計測スクリプトも `syntheticCases` を使う。
- `test/helpers/*.ts` は `typecheck:pie-chart`(include = `src/**`)の対象外で、既存 `test/` と同じ扱い。

- [ ] **Step 1: ケース生成器を helpers へ移す**

`pie-chart/test/helpers/syntheticCases.ts` を新規作成する。`SHORT_NAMES` から `syntheticCases` までは
現行 `render_hash.test.ts` からの**逐語コピー**(値・順序・コメントを変えない。1 文字でも変えると
26 ハッシュが動く)。

```ts
// =============================================================================
// syntheticCases.ts — render_hash 系テストが共有する合成入力 (サンプル外の入力分布)
// =============================================================================
// スライス数 2〜14 × 名前の長短 × 「その他」有無 + 特殊形 (1強/等分/長単語) の決定的な合成入力。
// `render_hash.test.ts` (軽い 24 ケース) と `render_hash_long.test.ts` (重い 2 ケース) が同じ
// 生成器から取るため、ケースの定義はここ 1 箇所に置く。名前・値を 1 つでも変えると SVG の
// SHA256 (`renderHashExpected.ts`) が動くので、変更は期待値の意図的な更新とセットで行う。
// =============================================================================

const SHORT_NAMES = [
  '円',
  '米ドル',
  'ユーロ',
  '英ポンド',
  '豪ドル',
  '加ドル',
  'スイスフラン',
  '香港ドル',
  '株式',
  '債券',
  '現金',
  'REIT',
  '先物',
  '預金',
] as const;

const LONG_NAMES = [
  'スウェーデンクローナ',
  'ニュージーランド・ドル',
  'オフショア人民元',
  '海外不動産投資信託',
  'ノルウェークローネ',
  '為替ヘッジ付資産',
  'シンガポールドル',
  'インドネシアルピア',
  'メキシコペソ',
  '南アフリカランド',
  'ブラジルレアル',
  'デンマーククローネ',
  'ポーランドズロチ',
  'ハンガリーフォリント',
] as const;

export interface Slice {
  name: string;
  value: number;
}

/**
 * n スライスの決定的な合成入力。値は逓減列 (先頭が大きく末尾が小さい) で、小スライス帯
 * (isSmall/isTiny) を必ず含むように減衰させる。withOther は末尾を「その他」へ置換する。
 */
function makeItems(n: number, style: 'short' | 'long', withOther: boolean): Slice[] {
  const names = style === 'short' ? SHORT_NAMES : LONG_NAMES;
  const items: Slice[] = [];
  let remaining = 100;
  for (let i = 0; i < n; i += 1) {
    // 先頭は残りの 45%、以降も残りの 45% ずつ取る逓減列。末尾は残り全部 (合計 100)。
    const value = i === n - 1 ? remaining : Math.round(remaining * 0.45 * 10) / 10;
    items.push({ name: names[i % names.length], value: Math.round(value * 10) / 10 });
    remaining = Math.round((remaining - value) * 10) / 10;
  }
  if (withOther) items[n - 1] = { ...items[n - 1], name: 'その他' };
  return items;
}

/** 合成ケース一覧 (名前 → 入力)。順序・内容とも決定的。 */
export function syntheticCases(): Record<string, Slice[]> {
  const cases: Record<string, Slice[]> = {};
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14]) {
    for (const style of ['short', 'long'] as const) {
      // 「その他」はスライス数が偶数のケースにだけ入れて両パターンを網羅する。
      cases[`gen_${style}_${n}${n % 2 === 0 ? '_other' : ''}`] = makeItems(n, style, n % 2 === 0);
    }
  }
  // 特殊形: 1強 (≥90%)・1強 (80–90%)・等分・長カタカナ単一語ペア。mark*** 系のドミナント帯
  // (<80 / 80–90 / <90) と等分系の境界を跨ぐ。
  cases.gen_dominant_92 = [
    { name: '国内株式', value: 92 },
    { name: '先物', value: 5 },
    { name: 'その他', value: 3 },
  ];
  cases.gen_dominant_85 = [
    { name: '国内債券', value: 85 },
    { name: '現金', value: 9 },
    { name: 'その他', value: 6 },
  ];
  cases.gen_equal_4 = [
    { name: '株式', value: 25 },
    { name: '債券', value: 25 },
    { name: 'REIT', value: 25 },
    { name: '現金', value: 25 },
  ];
  cases.gen_long_pair = [
    { name: 'スウェーデンクローナ', value: 55 },
    { name: 'ハンガリーフォリント', value: 45 },
  ];
  return cases;
}

/**
 * 配置計算が突出して重いケース (n=12 の長名)。`render_hash_long.test.ts` だけが描画し、
 * `render_hash.test.ts` は除外する。`gen_long_14_other` は正規化で値 0 の 2 項目が落ちて
 * `gen_long_12_other` と同一入力になるため、重さもハッシュも同じ。
 */
export const LONG_CASE_NAMES: readonly string[] = ['gen_long_12_other', 'gen_long_14_other'];
```

- [ ] **Step 2: 期待値の定数表を作る**

`pie-chart/test/helpers/renderHashExpected.ts` を新規作成する。26 エントリは現行
`pie-chart/test/__snapshots__/render_hash.test.ts.snap` からの機械的な写し(下表は現行 `.snap` の値を
そのまま並べたもの。**コミット前に `.snap` と目視で突き合わせる**のが受入条件)。

```ts
// =============================================================================
// renderHashExpected.ts — 合成入力 26 ケースの SVG SHA256 (定数表)
// =============================================================================
// スナップショットでなく定数表にするのは、vitest がローカル実行で未知の snapshot 名を黙って
// 書き足す (`updateSnapshot` の既定 `'new'`) ためで、ケース名を 1 文字違えると旧ハッシュが
// 検査されないまま緑になる。定数表なら `-u` も無言の追加も存在せず、更新は必ずこのファイルの
// diff として現れる。値の更新は挙動変更を意図した時だけ許される。ケースの脱落・綴り違いは
// `render_hash.test.ts` が `Object.keys(EXPECTED)` と生成ケース名の集合一致で固定する。
// =============================================================================

export const EXPECTED: Readonly<Record<string, string>> = {
  gen_dominant_85: 'b26e7727696719e9d143d5fcb9a3141cb6ac3f4f01b88396fb680d70cc0a74da',
  gen_dominant_92: '811fca462fede413d261ccd019c6ae6c4432ef03d2480eb6b67185674d5355e7',
  gen_equal_4: '7cebed42d987a611caa23b72e1e188f82714c62455c3db6f4392b8bed66a5cbd',
  gen_long_10_other: '455268e4b94cceae760d9d48fb723cd5afefba795f3a185543b3d16f8e2b0331',
  gen_long_12_other: 'e35c0157ad673a4c0daaa4fa1c7e4faa429ce9fcaa1a05e899c9acc6433ddee2',
  gen_long_14_other: 'e35c0157ad673a4c0daaa4fa1c7e4faa429ce9fcaa1a05e899c9acc6433ddee2',
  gen_long_2_other: '3f9a015a87f43d78248a34efc938663ad969b9415c0cd23d4646359c453426f4',
  gen_long_3: '27e54fe35a9bb04b9d08752aefa6ad71482cec4d1a12e01f62ca90ab7eaabfa6',
  gen_long_4_other: '8b00f6baf2cbc04cefa2e7362069865977af7e697e6ef35e7ad94ce99958c040',
  gen_long_5: '7b34ca7bd28d865c5029f7df7bcae8b6b0344b274af214df24260e8fb6516af5',
  gen_long_6_other: 'da2c05a2864267f9d8a4527813aa5dac851c7d16fae3892db079171c91ba23a4',
  gen_long_7: '22a172fcdb2314924bf213a6afa576a6892fdb4820fc46ff11b90b7e53b12f3f',
  gen_long_8_other: 'fe2358c1917b99c021daf6efb007596ebf2f0768bb094c6f772a5ee6eaf19ab3',
  gen_long_9: 'd3c3b569d6331e28b528b9739726de7dcdeeb018fd443c3fa8840b1cd1e61464',
  gen_long_pair: 'baa7f3845760fda8cc93e59291a3f1af85b0753d46024cb5267a17dbdf2e7bc5',
  gen_short_10_other: '6d03773ce1fc9ee48845cdff564b64b29bf8c6e931c2752a3399a58fbdc60f58',
  gen_short_12_other: '9ac8a02ab0240a0728774b41e0e430e269a8c502c4ba53ba38b3731069298892',
  gen_short_14_other: '9ac8a02ab0240a0728774b41e0e430e269a8c502c4ba53ba38b3731069298892',
  gen_short_2_other: '68f0d42caa5a5a2dca3e7c47e45044556b6e0dfe2895bac8337b0d67d5ce2265',
  gen_short_3: 'd914f138afa896b76fccb6908090a86a747342799f621be9582536f86a8f8dab',
  gen_short_4_other: '77bf23cbbda83a132a73247c148e8676fe6702b027037510b90aa6dae90bda8d',
  gen_short_5: 'fa07834dd75fd7d29a240c879ce07eb01ced56695d07deab29cfbc8c1753ea6b',
  gen_short_6_other: '7afefdb168e7c2c4608633efcf574bb72126cc101275ef2e4a1a2f32d644d5f3',
  gen_short_7: 'c4328cd41eb1124b48346abd0a9efa5442af02801b69bd9dabea6661fdb25072',
  gen_short_8_other: 'f6fafc3949a8afe3f5319e18b0c6080401e4c5efc2a0a151a2e83636e55209ed',
  gen_short_9: '5be5aefec046ee73c5603486368b5ed50829c516884ba73d45ba8cb9200bd56e',
};
```

- [ ] **Step 3: `render_hash.test.ts` を 24 ケース × `it.each` へ書き換える**

`pie-chart/test/render_hash.test.ts` の全文を次にする(ヘッダの「なぜハッシュを固定するか」は残し、
更新の許可条件は「定数表の更新は挙動変更を意図した時だけ」へ言い換える):

```ts
// =============================================================================
// render_hash.test.ts — サンプル外の合成入力に対する SVG ハッシュ固定 (特性テスト)
// =============================================================================
// byte-diff (out/_baseline) は samples.json の入力分布しか守らない。mark*** 系ゲートの
// リファクタで「既存サンプルは不変だが未収録の入力で誤発火する」穴を狭めるため、
// `syntheticCases.ts` の決定的な合成入力を描画し、SVG の SHA256 を `renderHashExpected.ts` の
// 定数表と突き合わせる。定数表の更新は挙動変更を意図した時だけ許される。
// 配置計算が突出して重い 2 ケース (`LONG_CASE_NAMES`) は `render_hash_long.test.ts` に分け、
// ここは残り 24 ケースをケース単位の `it` にする (1 ケースの失敗が他のケースを隠さない)。
// =============================================================================

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';
import { EXPECTED } from './helpers/renderHashExpected.js';
import { LONG_CASE_NAMES, syntheticCases } from './helpers/syntheticCases.js';

const ALL_CASES = Object.entries(syntheticCases());
const LIGHT_CASES = ALL_CASES.filter(([name]) => !LONG_CASE_NAMES.includes(name));

describe('合成入力の SVG ハッシュ固定 (サンプル外の入力分布)', () => {
  it('定数表のケース名と生成ケース名の集合が一致する (脱落・綴り違いを検出する)', () => {
    const generated = ALL_CASES.map(([name]) => name).sort();
    expect(Object.keys(EXPECTED).sort()).toEqual(generated);
    expect(generated).toHaveLength(26);
    for (const name of LONG_CASE_NAMES) expect(generated).toContain(name);
    expect(LIGHT_CASES).toHaveLength(24);
  });

  // timeout はルート `vitest run --coverage` (4 project 並列) 併走時の実測を余裕込みで収める値。
  // 配置計算そのものが重い決定的テストで、遅いこと自体は退行ではないので上限は並行負荷の実測に
  // 合わせる (`final_score.test.ts` と同じ判断)。
  it.each(LIGHT_CASES)(
    '%s の SHA256 が定数表と一致する',
    { timeout: 60_000 },
    async (name, items) => {
      const { svg } = await renderPdfStylePieToSvg(items, {});
      expect(createHash('sha256').update(svg).digest('hex')).toBe(EXPECTED[name]);
    },
  );
});
```

- [ ] **Step 4: `render_hash_long.test.ts` を作る**

```ts
// =============================================================================
// render_hash_long.test.ts — 合成入力のうち配置計算が重い 2 ケースの SVG ハッシュ固定
// =============================================================================
// 定数表 (`renderHashExpected.ts`) と生成器 (`syntheticCases.ts`) は `render_hash.test.ts` と同じ。
// 分けるのは、この 2 ケースだけで他の 24 ケースの合計を超える時間がかかり、同じファイルに
// 同居させると CI の臨界経路がこのファイルの長さになるため。
// `gen_long_14_other` は正規化 (`|value| > 0` フィルタ) で値 0 の 2 項目が落ちて
// `gen_long_12_other` と同一入力になる (ハッシュも同一)。n=14 のケースが n=12 と同じ分布しか
// 守っていないのはテスト設計の穴だが、`makeItems` を直すと全ケースのハッシュが動くため、
// 期待値の意図的な更新とセットで別途扱う。
// =============================================================================

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';
import { EXPECTED } from './helpers/renderHashExpected.js';
import { LONG_CASE_NAMES, syntheticCases } from './helpers/syntheticCases.js';

const LONG_CASES = Object.entries(syntheticCases()).filter(([name]) =>
  LONG_CASE_NAMES.includes(name),
);

describe('合成入力の SVG ハッシュ固定 (配置計算が重いケース)', () => {
  // timeout はルート CI 併走時の実測 (1 ケース約 65 秒が並列負荷で 2〜3 倍に伸びる) を余裕込みで
  // 収める値。配置計算の高速化が受入 (単独 5 秒以下) に達したら 60 秒へ縮める。
  it.each(LONG_CASES)(
    '%s の SHA256 が定数表と一致する',
    { timeout: 300_000 },
    async (name, items) => {
      const { svg } = await renderPdfStylePieToSvg(items, {});
      expect(createHash('sha256').update(svg).digest('hex')).toBe(EXPECTED[name]);
    },
  );
});
```

- [ ] **Step 5: `.snap` を削除し、整形する**

```powershell
git rm pie-chart/test/__snapshots__/render_hash.test.ts.snap
pnpm exec biome format --write pie-chart/test/render_hash.test.ts pie-chart/test/render_hash_long.test.ts pie-chart/test/helpers/syntheticCases.ts pie-chart/test/helpers/renderHashExpected.ts
pnpm run check:ci
pnpm run check:comments
```

期待: `check:ci` / `check:comments` とも exit 0(pie-chart は formatter 対象なので未整形だと `check:ci` が赤)。

- [ ] **Step 6: 通ることと、snapshot を書かないことを確認する**

```powershell
pnpm exec vitest run --project pie-chart test/render_hash
```

期待: `Test Files  2 passed (2)`、`Tests  27 passed (27)`(集合一致 1 + 軽量 24 + 重い 2)。
`Snapshots` の行が出ない。

```powershell
$env:CI = '1'
pnpm exec vitest run --project pie-chart test/render_hash
Remove-Item Env:CI
Get-ChildItem pie-chart/test/__snapshots__
git status --short pie-chart/test
```

期待: `CI=1` でも同じ 27 passed(`updateSnapshot: 'none'` 相当で新規 snapshot が書けない環境でも定数表は
影響を受けない)。`__snapshots__` には `final_score.test.ts.snap` と `mark_flags.test.ts.snap` だけがあり、
`render_hash*.snap` が生成されていない。`git status` は本タスクで意図した追加・変更・削除のみ。

- [ ] **Step 7: ゴールデン 3 種と型を確認してコミット**

本節共通の受入コマンド (2)(3) を実行する(`batch:diff` はテストのみの変更なので不要だが、走らせて
OK を見ておく)。

```powershell
git add pie-chart/test/helpers/syntheticCases.ts pie-chart/test/helpers/renderHashExpected.ts pie-chart/test/render_hash.test.ts pie-chart/test/render_hash_long.test.ts
git commit -m "test(pie-chart): render_hash を軽量 24 ケースと重い 2 ケースへ分け、期待ハッシュを定数表にする

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---


---

# 計画 A(部分ドラフト): 設定の分割 — web vitest の dom / node 分割と playwright の docs project

> 設計書 `docs/superpowers/specs/2026-09-06-ci-optimization-design.md` の 5 章と 6.1 章(docs project
> のみ)・4.4 節を実装する部分。計画 C(CI スクリプト同期)の C1 は本書 P2 の project 名に依存する
> (末尾 P3 参照)。

### P 系列の前提(2026-09-06 にこの端末で確認した事実)

- vitest は全パッケージ **4.1.11**(`pnpm ls vitest --depth 0`。root / server / shared / web すべて同版)。
  `vitest/config` は `defineConfig` / `mergeConfig`(vite の再輸出)/ `configDefaults` を export する。
- `@playwright/test` は **1.62.1**(`pnpm-lock.yaml`)。`playwright test --list` の現状は
  **35 tests in 9 files**。内訳: canvas 5 / capture_docs 2 / comment_panel 1 / filter_bar_layout 3 /
  header_layout 6 / note_bubble 2 / review_tab 2 / smoke 5 / tabbed_layout 9。
  → `capture_docs.spec.ts` を外すと **33**。
- `editor/web/test/*.test.ts` は **97 ファイル**(サブディレクトリなし、`@vitest-environment` プラグマ 0 件)。
- `editor/web/src` に `typeof window` / `typeof document` の環境分岐は **0 件**。node 環境へ移した
  テストが「別の分岐を通って緑になる」形の無言の退行は起きない(移した後に落ちるか通るかの二択)。
- `pnpm --filter web test compareService` は現状 `vite.config.ts` の `test` ブロック経由で動く
  (1 file / 14 tests / 2.5s)。この経路を壊さないことが `editor/web/vitest.config.ts`(薄い root)の存在理由。
- `check:comments` の装飾ボックスヘッダ検査は `editor/web/src` 等の src ルート限定で、
  `editor/web/*.config.ts` は対象外。新設する config は兄弟(`editor/shared/vitest.config.ts` /
  `editor/server/vitest.config.ts`)と同じく triple-slash 指示子 + 散文コメントの体裁にする。
- 作業ツリーには `docs/editor/images/{compare-tab,review-diff,reviews-list}.png` の未コミット差分
  (直前の e2e 再撮影)がある。P2 の「撮影が走らない」検証は `git status` の空ではなく **SHA256 の前後一致**で行う。
- pnpm の script は Windows では cmd.exe 経由で実行され、**cmd.exe は単一引用符を剥がさない**。
  `--project 'web-*'` と書くと vitest に `'web-*'`(引用符込み)が渡って一致しない。`package.json` 内は
  `\"web-*\"`(二重引用符)で書く。手打ちの Git Bash / PowerShell では `'web-*'` のままでよい。

#### DOM 依存の実測(初期リネームの根拠)

設計書 5 章の「18 ファイル」は `.vue` という文字列を含むテストの件数で、内訳は次の 2 種類。

| 種別 | 件数 | ファイル |
|---|---|---|
| `@vue/test-utils` または `.vue` を **import** する(mount する) | 16 | `BackButton` / `Button` / `Input` / `Select` / `StepperInput` / `commentPanel` / `inspectorGeom` / `overlays` / `previewPanel` / `reviewNoticeBar` / `reviewTabView` / `templateTable` / `useAutosave` / `useCascadingSelect` / `useIframeAutoFit` / `useUrlQuerySync` |
| `.vue` を **fs で読んで文字列走査**する(mount しない) | 2 | `iframeSandbox.guard`(`readdirSync` で `.vue`/`.ts` を走査)/ `reviewDetail.wording`(`ReviewDetail.vue` 等を `src()` で読む) |

初期リネームは前者 16 件。後者 2 件は DOM 不要の見込みなので node 側に残し、ステップ 7 のループで
落ちたときだけ移す(jsdom で走らせても通るが、起動費を払う理由が無い)。

`document\.|window\.|localStorage|DOMParser|HTMLElement` に触れるテストは **30 件**(設計書の 27 より多い。
正規表現の違い)。このうち上記 16 件に含まれないものが「ループで dom 側へ移る候補」:

`canvasActiveContent.guard` / `cropMarks` / `draftOwner` / `editorSession` / `htmlWorkerImpl` /
`iframeSandbox.guard` / `localRepos` / `localReposExtra` / `localReviewRepo` / `noteRepo` / `nunjucksRender` /
`pageView` / `partKey.pageIndex` / `partKey` / `partPreviewDoc` / `pendingReviews.store` / `redlineApply` /
`redlineDiff` / `redlineTree` / `renderHostClient` / `restBundle.guard` / `reviewRepo.local` /
`useGeomHandles` / `xssGuards`(24 件)。

grep は「文字列として含む」しか見ておらず、`htmlWorkerImpl` の `DOMParser` は linkedom 由来、guard 系の
`document.` は検査対象ソースの正規表現、というように node でも通るものが混じる。逆に grep に掛からなくても
`src/lib/draftOwner.ts` / `src/lib/theme.ts` / `src/stores/auth.ts` / `src/stores/editorSession.ts` の
`localStorage` 呼び出しを **関数経由で踏む**テストは落ちる(`tabMemory.store` / `templateEditorService` /
`templatePreviewService` がこの型の候補)。判定は実測に一本化する(ステップ 7)。

---

### Task P1: web vitest を `web-dom`(jsdom)/ `web-node`(node)の 2 project に分ける

**Files:**
- 新規: `editor/web/vitest.dom.config.ts`
- 新規: `editor/web/vitest.node.config.ts`
- 新規: `editor/web/vitest.config.ts`(薄い root)
- 変更: `editor/web/vite.config.ts`(`test` ブロック撤去)
- 変更: `vitest.config.ts`(ルート。`projects` の web 行を leaf 2 本へ)
- 変更: `editor/web/tsconfig.json`(`include` に config 3 本)
- 変更: `package.json`(`test:editor`)
- 改名: `editor/web/test/*.test.ts` → `*.dom.test.ts`(初期 16 件 + ループで判明した分)
- 変更: `editor/README.md`(テストコマンド・カバレッジ正典の記述)
- 変更: `scripts/ci-affected.mjs`(editor 領域のコメント)

**Interfaces:**
- vitest project 名: `web` を廃し `web-dom` / `web-node` に分ける。選別は `--project web-dom` /
  `--project web-node` / `--project "web-*"`。`--project web` は "No projects matched" になる(意図どおり)。
- ファイル名規約: **`test/**/*.dom.test.ts` = jsdom が要るテスト**。それ以外の `*.test.ts` は node。
- coverage の `include`(ルート `vitest.config.ts`)は src 側のパスなので不変。閾値も不変。
- `pnpm --filter web test <name>` の経路は薄い root 設定経由で従来どおり動く。

- [ ] **ステップ 0: ベースラインを記録する**(分割後の「件数不変」の比較対象)

  ```bash
  pnpm exec vitest run --project web --reporter=dot 2>&1 | tail -6
  ```

  末尾の `Test Files` / `Tests` / `Duration` を控える(現状の値: 本書末尾「ベースライン」節)。
  この 2 つの件数が分割後の `--project "web-*"` で **一致**することが受入条件。

- [ ] **ステップ 1: `editor/web/vitest.dom.config.ts` を作る**

  ```ts
  /// <reference types="vitest/config" />
  import { defineConfig, mergeConfig } from 'vitest/config';
  import viteConfig from './vite.config';

  // web の vitest は dom / node の 2 project に分ける。jsdom の起動はファイルごとに約 1.5 秒かかり、
  // DOM に触れないテストまで jsdom で走らせると、この起動費だけで `test:editor` の過半を占める。
  // jsdom が要るのは `*.dom.test.ts` と名付けたファイルだけで、それ以外は `vitest.node.config.ts`
  // が node 環境で走らせる。
  //
  // `vite.config.ts` を `mergeConfig` で取り込むのは、`vue()` プラグインと `resolve.alias`(`@` /
  // `@editor/shared`)が `test` ブロックの外にあり、`vitest.*.config.ts` が存在すると vitest は
  // `vite.config.ts` を読まなくなるため。coverage はルート `vitest.config.ts` に一本化されており、
  // ここでは environment / globals / 対象ファイルだけを持つ。
  export default mergeConfig(
    viteConfig,
    defineConfig({
      test: {
        // ルート `vitest.config.ts` の `projects` 集約で `--project web-dom` の選別を効かせるための名前。
        // `web-` 接頭辞は node 側と対で、`--project "web-*"` のワイルドカード選別の単位。
        name: 'web-dom',
        environment: 'jsdom',
        globals: true,
        include: ['test/**/*.dom.test.ts'],
      },
    }),
  );
  ```

- [ ] **ステップ 2: `editor/web/vitest.node.config.ts` を作る**

  ```ts
  /// <reference types="vitest/config" />
  import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
  import viteConfig from './vite.config';

  // DOM に触れない web テストの project。jsdom を立てずに node 環境で走らせる(分割の理由と
  // `vite.config.ts` を取り込む理由は `vitest.dom.config.ts` を参照)。`window` / `document` /
  // `localStorage` が要るテストは `*.dom.test.ts` へ改名して dom 側へ移す。node 側で
  // `document is not defined` 等の ReferenceError で落ちるのが移す合図。
  export default mergeConfig(
    viteConfig,
    defineConfig({
      test: {
        // ルート `vitest.config.ts` の `projects` 集約で `--project web-node` の選別を効かせるための名前。
        name: 'web-node',
        environment: 'node',
        globals: true,
        include: ['test/**/*.test.ts'],
        // `include` は `*.dom.test.ts` にも一致するため、dom 側の担当を除いて二重実行を防ぐ。
        // `configDefaults.exclude` を展開して残すのは、素の配列にすると vitest 既定の
        // `node_modules` / `dist` 除外が消えるため。
        exclude: [...configDefaults.exclude, '**/*.dom.test.ts'],
      },
    }),
  );
  ```

- [ ] **ステップ 3: `editor/web/vitest.config.ts`(薄い root)を作る**

  ```ts
  /// <reference types="vitest/config" />
  import { defineConfig } from 'vitest/config';

  // web ディレクトリで vitest を直に起動する経路(`pnpm --filter web test <name>` = `vitest run`)の
  // ための root 設定。vitest が自動検出するのは `vitest.config.*` / `vite.config.*` だけで、
  // `vitest.dom.config.ts` / `vitest.node.config.ts` は検出されないため、ここから 2 つの leaf を
  // `projects` で束ねる。
  //
  // ワークスペース root の `vitest.config.ts` はこのファイルを列挙しない。参照された config の中の
  // `test.projects` は無視され(全ファイルが node で 1 project として走る)、root 側は leaf 2 本を
  // 直接列挙する。`projects` が効くのは「自身が root として起動されたとき」だけ。
  export default defineConfig({
    test: {
      projects: ['./vitest.dom.config.ts', './vitest.node.config.ts'],
    },
  });
  ```

- [ ] **ステップ 4: `editor/web/vite.config.ts` から `test` ブロックを撤去する**

  削除するのは次の 8 行(現行 46〜53 行目)。`plugins` / `resolve.alias` / `worker` / `server` は
  そのまま残す。先頭の `/// <reference types="vitest/config" />` と `import { defineConfig } from
  'vitest/config'` も残す(leaf 側の `mergeConfig` へ渡す `UserConfig` の型を同じ出所に揃える)。

  ```ts
    // coverage はルート vitest.config.ts に一本化(全プロジェクト集約・閾値 85%)。ここは
    // web プロジェクトの environment/globals のみを担う。
    test: {
      // ルート vitest.config.ts の `projects` 集約で `--project web` 選別を効かせるための名前。
      name: 'web',
      environment: 'jsdom',
      globals: true,
    },
  ```

  残る末尾は次の形になる(`server` ブロックの閉じ括弧の直後に `});`)。

  ```ts
    server: {
      // Vite 既定の 5173 は他ツールと被りやすいため、衝突しにくい 24681 に固定
      // (server 側 :24680 と対で予約。選定理由は editor/README.md の「LAN 公開」節)。
      port: 24681,
      proxy: {
        '/api': {
          target: 'http://localhost:24680',
          changeOrigin: true,
        },
      },
    },
  });
  ```

- [ ] **ステップ 5: ルート `vitest.config.ts` の `projects` と冒頭コメントを更新する**

  `projects` の変更(旧 → 新):

  ```ts
  // 旧
      projects: [
        'editor/shared/vitest.config.ts',
        'editor/server/vitest.config.ts',
        'editor/web/vite.config.ts',
        'pie-chart/vitest.config.ts',
      ],
  // 新
      projects: [
        'editor/shared/vitest.config.ts',
        'editor/server/vitest.config.ts',
        // web は dom(jsdom)/ node の 2 leaf を**直接**列挙する。`editor/web/vitest.config.ts`(薄い
        // root。`pnpm --filter web test` 用)を列挙すると、参照 config 内の `test.projects` は無視されて
        // 全ファイルが node で走る。分割の理由は `vitest.dom.config.ts` のコメントを参照。
        'editor/web/vitest.dom.config.ts',
        'editor/web/vitest.node.config.ts',
        'pie-chart/vitest.config.ts',
      ],
  ```

  冒頭コメント 4〜6 行目の環境の記述(旧 → 新):

  ```ts
  // 旧
  // 個別 config に残し、ここでは `projects` で集約して `vitest run` 一発で全プロジェクトを
  // 各環境(web=jsdom / 他=node)で実行する。coverage は Vitest の仕様上ラン全体で 1 つしか
  // 新
  // 個別 config に残し、ここでは `projects` で集約して `vitest run` 一発で全プロジェクトを
  // 各環境(web-dom=jsdom / 他=node)で実行する。coverage は Vitest の仕様上ラン全体で 1 つしか
  ```

- [ ] **ステップ 6: `editor/web/tsconfig.json` の `include` に config 3 本を足す**(vue-tsc の検査対象)

  ```json
  // 旧
    "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue", "vite.config.ts"]
  // 新
    "include": [
      "src/**/*.ts",
      "src/**/*.d.ts",
      "src/**/*.vue",
      "vite.config.ts",
      "vitest.config.ts",
      "vitest.dom.config.ts",
      "vitest.node.config.ts"
    ]
  ```

- [ ] **ステップ 7: 初期リネーム(16 件)**(`editor/web` で実行)

  ```bash
  cd editor/web/test
  for f in BackButton Button Input Select StepperInput commentPanel inspectorGeom overlays \
           previewPanel reviewNoticeBar reviewTabView templateTable useAutosave \
           useCascadingSelect useIframeAutoFit useUrlQuerySync; do
    git mv "$f.test.ts" "$f.dom.test.ts"
  done
  git status --short . | grep -c '^R'   # 期待: 16
  ```

- [ ] **ステップ 8: node 側を走らせ、環境起因で落ちたものだけを dom へ移すループ**(ルートで実行)

  ```bash
  S=$CLAUDE_SCRATCHPAD   # 上記スクラッチパッドのパス
  pnpm exec vitest run --project web-node --reporter=default > "$S/web-node.log" 2>&1
  # 環境起因の失敗ファイルを抜き出す
  grep -E "ReferenceError: (document|window|localStorage|sessionStorage|navigator|HTMLElement|DOMParser|Element|Node|self|location) is not defined" "$S/web-node.log" | head
  grep -E "^\s*(FAIL|×|❯) .*test/[A-Za-z0-9_.]+\.test\.ts" "$S/web-node.log" | grep -oE "test/[A-Za-z0-9_.]+\.test\.ts" | sort -u > "$S/failed.txt"
  cat "$S/failed.txt"
  ```

  判定規則(**1 ファイルずつ、ログの原因行を見て決める**):
  - 失敗の原因が `ReferenceError: <DOM グローバル> is not defined`、または `TypeError` で
    `document` / `window` / `localStorage` / `URL.createObjectURL` / `MutationObserver` /
    `ResizeObserver` 等の **ブラウザ API 不在**に帰着するもの → dom 側へ移す:

    ```bash
    for f in $(cat "$S/failed.txt"); do git mv "editor/web/$f" "editor/web/${f%.test.ts}.dom.test.ts"; done
    ```

  - それ以外の失敗(アサーションの不一致・モック不発など) → **移さない**。node で走ったことで
    露見した別の問題なので、原因をメモして本タスクの範囲外として報告する(移して緑にする
    のは検査の消去)。
  - `failed.txt` が空になるまで上の 2 手順を繰り返す。実測の見込みは 2〜3 周。

  ループ終了時の期待:

  ```bash
  pnpm exec vitest run --project web-node --reporter=dot 2>&1 | tail -5
  #  Test Files  <97 - dom 件数> passed
  #  Tests       <node 側件数> passed
  ls editor/web/test/*.dom.test.ts | wc -l     # dom 件数(16 + ループ分。見込み 22〜30)
  ls editor/web/test/*.test.ts | wc -l          # 97(.dom.test.ts も含む総数。増減なし)
  ```

  dom 側の最終件数と、ループで移したファイルの一覧は **コミットメッセージ本文に列挙**する
  (「18 → N」の実測値は設計書の見込みを置き換える情報で、git 履歴に残す)。

- [ ] **ステップ 9: `package.json` の `test:editor` を更新する**

  ```json
  // 旧
      "test:editor": "vitest run --project shared --project server --project web",
  // 新
      "test:editor": "vitest run --project shared --project server --project \"web-*\"",
  ```

  二重引用符にする理由は前提節(cmd.exe は単一引用符を剥がさない)。

- [ ] **ステップ 10: 両 project をまとめて検証する**

  ```bash
  pnpm exec vitest run --project 'web-*' --reporter=dot 2>&1 | tail -6
  ```

  期待: `Test Files 97 passed (97)`、`Tests 1126 passed (1126)`(ステップ 0 と同じ)、失敗 0。dot reporter の
  行頭に `|web-dom|` / `|web-node|` の両方が現れる(default reporter で確認してもよい)。
  `Duration` をステップ 0 と並べて控える(jsdom 起動が dom 側だけになる分の短縮。目安として
  `environment` の合計が 146.78s → dom 件数 × 約 1.5s 級)。

  ```bash
  pnpm exec vitest run --project web 2>&1 | tail -3
  ```

  期待: `No projects matched the filter "web"` 相当のエラーで終了コード非 0(旧名の参照が残って
  いないことの確認。`grep -rn "\-\-project web\b" package.json scripts editor/README.md` も 0 件)。

  ```bash
  pnpm --filter web test compareService 2>&1 | tail -6
  ```

  期待: `Test Files 1 passed (1)` / `Tests 14 passed (14)`(薄い root 経由で `web-node` として走る。
  default reporter なら `✓ |web-node| test/compareService.test.ts (14 tests)`)。

  ```bash
  pnpm --filter web test Button 2>&1 | tail -6
  ```

  期待: `|web-dom| test/Button.dom.test.ts` として走り緑(薄い root が dom 側にも届くことの確認)。

  ```bash
  pnpm run test:editor 2>&1 | tail -6
  ```

  期待: shared / server / web-dom / web-node の 4 project が走り、`Tests` の合計が分割前の
  `test:editor`(設計書 0 章の 2367 件)と一致する。

  ```bash
  pnpm run test:coverage 2>&1 | tail -15
  ```

  期待: 終了コード 0、`ERROR: Coverage for ... does not meet global threshold` が **無い**。
  coverage `include` は src パスなので分割の影響を受けないが、node 側へ移ったテストが同じ src を
  同じ経路で踏むことの確認を兼ねる(`typeof window` 分岐が src に無いことは前提節で確認済み)。

  ```bash
  pnpm run typecheck:editor 2>&1 | tail -3
  ```

  期待: エラー 0(`tsconfig.json` の `include` に足した config 3 本が vue-tsc を通る)。

- [ ] **ステップ 11: `editor/README.md` と `scripts/ci-affected.mjs` の記述を同じコミットで更新する**

  `editor/README.md` 59〜60 行目(旧 → 新):

  ```
  旧: pnpm test        # ルート集約の vitest（projects で全 workspace を一括実行）
  新: pnpm test        # ルート集約の vitest（projects で全 workspace を一括実行。web は web-dom / web-node の 2 project）
  ```

  70〜73 行目のカバレッジ段落の直後に次の段落を足す:

  ```
  web のテストは vitest の project が 2 つある。`test/**/*.dom.test.ts` は **`web-dom`（jsdom）**、
  それ以外の `test/**/*.test.ts` は **`web-node`（node）** で走る。jsdom の起動はファイルごとに
  約 1.5 秒かかるため、`document` / `window` / `localStorage` に触れるテストだけを `.dom.test.ts` に
  する（node 側で `... is not defined` の ReferenceError が出たら改名して移す）。両方を選ぶときは
  `vitest run --project "web-*"`。`pnpm --filter web test <name>` は `web/vitest.config.ts`（薄い
  root）経由で両 project を束ねる。設定の実体は `web/vitest.dom.config.ts` / `web/vitest.node.config.ts`。
  ```

  `scripts/ci-affected.mjs` 27〜31 行目の editor 領域に、`stages` の直前へコメントを足す:

  ```js
    editor: {
      label: 'editor (shared+server+web)',
      match: (p) => p.startsWith('editor/'),
      // `test:editor` は shared / server / web-dom(jsdom)/ web-node の 4 project を選ぶ
      // (web の dom/node 分割は `editor/web/vitest.dom.config.ts` を参照)。
      stages: ['typecheck:editor', 'test:editor', 'build:editor', 'e2e:editor'],
    },
  ```

- [ ] **ステップ 12: 整形・規約検査・コミット**

  ```bash
  pnpm exec biome check --write editor/web/vitest.config.ts editor/web/vitest.dom.config.ts \
    editor/web/vitest.node.config.ts editor/web/vite.config.ts editor/web/tsconfig.json
  pnpm run check:comments 2>&1 | tail -3     # 期待: 新規警告 0
  pnpm run test:scripts 2>&1 | tail -3       # 期待: ci-affected.test.mjs 緑(コメント変更のみ)
  git add -A editor/web vitest.config.ts package.json editor/README.md scripts/ci-affected.mjs
  git status --short | grep -vE "^(R|M|A) " # 期待: docs/editor/images の既存 M 以外に何も無い
  ```

  コミットメッセージ(本文に dom 側の最終件数と、ループで移したファイル名を列挙する):

  ```
  test(editor): web の vitest を web-dom / web-node の 2 project に分け、DOM 非依存テストを node で走らせる

  jsdom の起動費がファイルごとに約 1.5 秒かかり、DOM に触れないテストまで jsdom で走らせると
  test:editor の過半がこの起動費になっていた。`*.dom.test.ts` だけを jsdom(web-dom)で走らせ、
  残りを node(web-node)で走らせる。参照 config 内の `test.projects` は無視されるため、
  ルート vitest.config.ts は leaf 2 本を直接列挙し、`pnpm --filter web test` 用に薄い root 設定を併設する。

  dom 側: (ここに実行結果の dom 側ファイル数と、node 側で ReferenceError になって移した
  ファイル名を列挙する)。テスト件数は分割前後で (ステップ 5 で確認した件数) のまま不変。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  ```

---

### Task P2: playwright に `docs` project を作り、`capture_docs.spec.ts` を `ci` / GH から外す

**Files:**
- 変更: `editor/playwright.config.ts`(`projects` を `chromium` / `docs` の 2 つに)
- 変更: `package.json`(`test:e2e` / `e2e:editor`)
- 変更: `editor/README.md`(e2e の説明を追加)
- 変更: `docs/editor/src/設計正典.md`(チェックリスト 4 の文言)
- 変更(コメントのみ): `editor/e2e/capture_docs.spec.ts` 冒頭の実行例

**Interfaces:**
- playwright project 名: `chromium`(挙動 spec 全部。`capture_docs.spec.ts` と `**/*.rest.spec.ts` を ignore)、
  `docs`(`capture_docs.spec.ts` のみ)。`rest` project は計画 B1 が足す(ignore パターンは今回入れておく)。
- `test:e2e` = `playwright test -c editor/playwright.config.ts --project chromium`(`ci` と GH Actions)。
- `e2e:editor` = 同 `--project chromium --project docs`(`ci:affected` の editor 領域)。
- `.github/workflows/ci.yml` は `pnpm run test:e2e` を呼んでいるので **yml は無改修**で chromium だけになる。

- [ ] **ステップ 1: 撮影対象画像の SHA256 を控える**(「撮影が走らない」検証の基準)

  ```bash
  S=$CLAUDE_SCRATCHPAD
  sha256sum docs/editor/images/*.png > "$S/images-before.txt"
  git status --short docs/editor/images > "$S/images-status-before.txt"
  ```

- [ ] **ステップ 2: `editor/playwright.config.ts` の `projects` を書き換える**

  旧(1 行):

  ```ts
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ```

  新:

  ```ts
    projects: [
      {
        // 挙動を検証する spec 全部。`test:e2e`(`ci` と GitHub Actions)と `e2e:editor` の両方で走る。
        // `capture_docs.spec.ts` を外すのは、あの spec が git 管理下の `docs/editor/images/*.png` を
        // 書き換えるため。フル `ci` / GH の結果としてリポジトリの成果物が変わるのは検査ではない。
        // `*.rest.spec.ts` は SQL Server 相当のフェイクを立てる `rest` project(`E2E_REST=1` の
        // ときだけ `projects` に入る)の担当で、local 経路のサーバ相手に走らせると意味が変わる。
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
        testIgnore: ['**/capture_docs.spec.ts', '**/*.rest.spec.ts'],
      },
      {
        // 操作手引き(docs/editor)のスクリーンショットを撮り直す project。`e2e:editor`(`ci:affected`
        // の editor 領域)だけが `--project docs` で選ぶ。editor に触れた push でだけ再撮影が走り、
        // 差分は「再撮影」としてコミットする。
        name: 'docs',
        use: { ...devices['Desktop Chrome'] },
        testMatch: '**/capture_docs.spec.ts',
      },
    ],
  ```

  ファイル冒頭の英語 JSDoc はそのまま(webServer の理由説明で、project 構成とは独立)。

- [ ] **ステップ 3: `package.json` の 2 script を更新する**

  ```json
  // 旧
      "test:e2e": "playwright test -c editor/playwright.config.ts",
      "e2e:editor": "playwright test -c editor/playwright.config.ts",
  // 新
      "test:e2e": "playwright test -c editor/playwright.config.ts --project chromium",
      "e2e:editor": "playwright test -c editor/playwright.config.ts --project chromium --project docs",
  ```

- [ ] **ステップ 4: `--list` で振り分けを確認する**(サーバ起動なし・数秒)

  ```bash
  cd editor
  pnpm exec playwright test --list --project chromium 2>&1 | tail -1
  # 期待: Total: 33 tests in 8 files
  pnpm exec playwright test --list --project docs 2>&1 | tail -1
  # 期待: Total: 2 tests in 1 file
  pnpm exec playwright test --list 2>&1 | tail -1
  # 期待: Total: 35 tests in 9 files(project 無指定 = 両方。裸の playwright test は撮影を含む)
  pnpm exec playwright test --list --project chromium 2>&1 | grep -c capture_docs
  # 期待: 0
  ```

- [ ] **ステップ 5: 実行で確認する**(ルートで。dev サーバは webServer が起動、または既存を再利用)

  ```bash
  pnpm run test:e2e 2>&1 | tail -4
  ```

  期待: `Running 33 tests using 4 workers` … `33 passed`。実行後:

  ```bash
  sha256sum docs/editor/images/*.png | diff - "$S/images-before.txt" && echo IMAGES_UNCHANGED
  git status --short docs/editor/images | diff - "$S/images-status-before.txt" && echo STATUS_UNCHANGED
  ```

  期待: `IMAGES_UNCHANGED` と `STATUS_UNCHANGED` の両方(撮影 spec が走っていない)。

  ```bash
  pnpm run e2e:editor 2>&1 | tail -4
  ```

  期待: `Running 35 tests using 4 workers` … `35 passed`。実行後は `docs/editor/images/*.png` の
  mtime が更新される(内容が同一なら SHA256 は一致することもある。差分が出た場合は P1/P2 の変更で
  UI は変わっていないので、直前の未コミット再撮影と同じ「再撮影」としてまとめてコミットする)。

- [ ] **ステップ 6: ドキュメントを更新する**

  `docs/editor/src/設計正典.md` チェックリスト 4(563〜564 行目。旧 → 新):

  ```
  旧:
  4. CI 集約は `pnpm ci`（`check:comments → check:ci → typecheck → test:coverage → build →
     test:e2e`）。e2e の `capture_docs.spec.ts` は `docs/editor/images/` を再撮影して byte 差分を
     作るため、差分は「再撮影」としてコミットする。
  新:
  4. CI 集約は `pnpm ci`（`check:comments → check:ci → typecheck → test:coverage → build →
     test:e2e`）。e2e は playwright の project 2 つで、`test:e2e`（`ci`・GH Actions）は `chromium`
     だけを走らせる。`capture_docs.spec.ts` は `docs` project にあり、`e2e:editor`（`ci:affected` の
     editor 領域）だけが走らせて `docs/editor/images/` を再撮影する。その byte 差分は「再撮影」として
     コミットする。
  ```

  (設計正典は @import 用の原稿で冊子に含めないため `build_all.py` の再実行は不要。冊子側の
  `docs/editor/src/設計書.md` 709 行目「`capture_docs.spec.ts` は手引き用スクリーンショットの
  再撮影も兼ねる」は `pnpm test:e2e` の説明として **誤りになる**が、設計書は冊子に含まれ HTML の再生成を
  伴うので、本タスクでは触らず C 部の docs タスク(または次回の設計書改訂)へ回す。)

  `editor/README.md`: P1 ステップ 11 で足した web の段落の直後に次を足す:

  ```
  e2e（Playwright）は project が 2 つある。`chromium` は挙動を検証する spec 全部で、`pnpm test:e2e`
  （`ci`・GitHub Actions）が走らせる。`docs` は `e2e/capture_docs.spec.ts` だけで、操作手引きの
  `docs/editor/images/*.png` を撮り直す。撮影は git 管理下の成果物を書き換えるため `ci` には入れず、
  `pnpm e2e:editor`（`ci:affected` の editor 領域 = editor に触れた push）だけが
  `--project chromium --project docs` で走らせる。撮り直した画像の差分は「再撮影」としてコミットし、
  `py -3.13 docs/_build/build_all.py --project editor` で HTML を作り直す。撮影だけ手で走らせるときは
  `cd editor && pnpm exec playwright test --project docs`。
  ```

  `editor/e2e/capture_docs.spec.ts` 4〜5 行目(旧 → 新。コメントのみ):

  ```
  旧:
  // 実行は editor 配下で:
  //   pnpm exec playwright test e2e/capture_docs.spec.ts
  新:
  // 実行は editor 配下で(`docs` project だけが本 spec を担当し、`chromium` は ignore する):
  //   pnpm exec playwright test --project docs
  ```

- [ ] **ステップ 7: 整形・検査・コミット**

  ```bash
  pnpm exec biome check --write editor/playwright.config.ts editor/e2e/capture_docs.spec.ts
  pnpm run check:comments 2>&1 | tail -3   # 期待: 新規警告 0
  pnpm run test:scripts 2>&1 | tail -3     # 期待: 緑(ci-affected.test.mjs は script 名しか見ない)
  git add editor/playwright.config.ts package.json editor/README.md docs/editor/src/設計正典.md editor/e2e/capture_docs.spec.ts
  ```

  コミットメッセージ:

  ```
  test(editor): 手引きの再撮影 e2e を docs project に分け、ci と GitHub Actions では chromium だけを走らせる

  `capture_docs.spec.ts` は git 管理下の `docs/editor/images/*.png` を書き換えるため、フル `ci` と
  GH Actions の結果としてリポジトリの成果物が変わっていた。playwright の project を `chromium`
  (挙動 spec 33 件)と `docs`(撮影 2 件)に分け、`test:e2e` は chromium のみ、`e2e:editor`
  (ci:affected の editor 領域)は両方を走らせる。`*.rest.spec.ts` の ignore は rest project の
  追加に備えて chromium 側へ先に置く。

  Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF
  ```

  未コミットの `docs/editor/images/*.png`(直前の再撮影 3 枚)は本コミットに **含めない**。
  ステップ 5 の `e2e:editor` で差分が増えた場合も同様に、`docs(editor): 画面を再撮影する` の
  別コミット(+ `build_all.py --project editor` の HTML 再生成)にまとめる。

---

#### ベースライン(P1 ステップ 0 の比較対象。2026-09-06 のこの端末)

- `pnpm exec vitest run --project web --reporter=dot`(web 単独、coverage 無し):

  ```
   Test Files  97 passed (97)
        Tests  1126 passed (1126)
     Duration  67.64s (transform 5.63s, setup 0ms, import 64.74s, tests 24.95s, environment 146.78s)
  ```

  分割後の `--project 'web-*'` は **97 files / 1126 tests** で一致すること。`environment` の積算
  146.78s は 97 ファイル分の jsdom 起動費(1 ファイル約 1.5 秒)で、分割後は dom 側の件数分だけになる
  (dom 26 件なら約 40s 級。4 workers で割った壁時計の短縮は 20〜30 秒の見込み)。

---

# 計画 A(部分)— CI スクリプトの同期・GH Actions・ポート検査(C1〜C6)

設計の根拠: `docs/superpowers/specs/2026-09-06-ci-optimization-design.md` の 1 章(分割)・4 章(CI スクリプトの同期)・9 章(GH Actions)・10 章 / 10.1(検証・flaky 要因)。本書はそのうち「CI スクリプトと GH Actions」の実装手順。pie-chart 高速化(2 章)・render_hash 分割(3 章)・vitest project 分割(5 章)・playwright の `docs` project(6.1)は別パート(P 系列)の担当。

### C 系列の前提と順序

- **実行順**: C1 → C2 → C3+C4(同一コミット) → C5 → C6。C3 の yml ⊆ ci 検査は C4 で yml を並べ替えるまで赤なので、C3 と C4 は 1 コミットにまとめる(設計 4.3 の明記)。
- **P 系列との依存**: `test:e2e` / `e2e:editor` への `--project chromium` / `--project docs` の付与は `docs` project を作る P タスク側で行う(project が無いのに `--project docs` を書くと playwright が "No projects matched" で落ちるため、同じコミットに置く必要がある)。本パートの C1 は `ci` の段順序と `build:editor` の別名化だけを持つ。C5 は `test:e2e` の**先頭**にポート検査を前置するので、P タスクが先に入っていれば `--project chromium` を残したまま前置し、後なら P タスク側が末尾へ足す(同じ 1 行を両方が触る。衝突時は「先頭 = ポート検査、末尾 = project 指定」で合成する)。
- **既存の検証手段**: `scripts/*.test.mjs` は `node:test`(`pnpm run test:scripts`)。`ci-affected.test.mjs` は疑似 git リポジトリを組んで `--dry-run` の実行計画を固定する方式で、`pre-push.test.mjs` は純関数を import して固定する方式。C2 は後者の形を `ci-affected.mjs` にも持ち込む(main を argv ガードで囲み、判定を export する)。
- **Windows 上の pnpm script は cmd で走る**(`.npmrc` に `shell-emulator` は無い)。`X=1 cmd` 形の環境変数前置は使えない。C5 の設計判断はこの制約から出ている。
- コメントは `docs/コメント規約.md`(なぜを書く・日本語散文 + 英語ドメイン用語・識別子はバッククォート・経緯や日付を書かない)。`scripts/` は装飾ボックスヘッダの検査対象ルート(`check-comments.py` の `box_header_roots`)。
- コミットメッセージは `git log --oneline -15` の形(`<type>(<scope>): 日本語の動詞止め`)。末尾に `Claude-Session:` 行を付ける。

---

### Task C1: `ci` の段順序と `build:editor` の別名化

**Files:**
- 変更: `package.json`(`scripts.ci`、`scripts.build:editor`)

**Interfaces:**
- `pnpm run ci` の段順序(設計 4.1 の正典): `check:comments → check:claude-hooks → check:ci → test:scripts → typecheck → test:coverage → test:docs → pie-chart:batch → pie-chart:batch:diff → build → test:e2e`
- `build:editor` = `pnpm run build`(本体 1 か所。`ci-affected.mjs` の editor 領域 stages 名は不変)

**Steps:**

- [ ] `package.json` の 2 行を書き換える

```diff
-    "build:editor": "tsc -b editor/server && pnpm --filter web run build",
+    "build:editor": "pnpm run build",
```

```diff
-    "ci": "pnpm run check:comments && pnpm run check:claude-hooks && pnpm run check:ci && pnpm run test:scripts && pnpm run typecheck && pnpm run test:coverage && pnpm run build && pnpm run test:e2e",
+    "ci": "pnpm run check:comments && pnpm run check:claude-hooks && pnpm run check:ci && pnpm run test:scripts && pnpm run typecheck && pnpm run test:coverage && pnpm run test:docs && pnpm run pie-chart:batch && pnpm run pie-chart:batch:diff && pnpm run build && pnpm run test:e2e",
```

  `test:docs` を coverage の後・batch の前に置くのは、Python 側の失敗(pytest)を Node の重い段(build / e2e)より先に出すため。`pie-chart:batch:diff` は `out/_baseline` が無いと落ちる(設計 4.1。clone 直後の手順は C6 で README へ書く)。

- [ ] 段の並びを機械的に確認する

```
node -p "require('./package.json').scripts.ci.split(' && ').map(s => s.replace('pnpm run ', '')).join('\n')"
```

  期待出力(11 行、この順):

```
check:comments
check:claude-hooks
check:ci
test:scripts
typecheck
test:coverage
test:docs
pie-chart:batch
pie-chart:batch:diff
build
test:e2e
```

- [ ] 別名が本体と同じ結果になることを確認する(約 15 秒)

```
pnpm run build:editor
```

  期待: `tsc -b editor/server` と `web` の vite build が順に走り exit 0。`editor/web/dist/` が更新される。

- [ ] 既存のスクリプトテストが緑のままであることを確認する(`--all` の計画テストは段名 `ci` / `ci:offline` しか見ないので影響なし)

```
pnpm run test:scripts
```

  期待: `# pass` の件数が現状(clean 3 + ci-affected 8 + pre-push 7 = 18)で `# fail 0`。

- [ ] コミット

```
git add package.json
git commit -m "chore(ci): ci の段構成に test:docs と pie-chart の byte 比較を加え build:editor を build の別名にする

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---

### Task C2: `ci-affected.mjs` の領域判定を純関数へ切り出し、README 単独変更と `scripts/` を明示的に扱う

**Files:**
- 変更: `scripts/ci-affected.mjs`(判定を `classifyChanges` として export、main を argv ガードで囲む、`BENIGN_FILES` / `ci-machinery` 領域 / `BENIGN_PREFIXES` 縮小)
- 変更: `scripts/ci-affected.test.mjs`(純関数テスト 4 本 + dry-run の出力テスト 2 本)

**Interfaces:**
- `export function classifyChanges(paths: string[]): { areas: string[]; benign: string[]; fullCi: string | null }`
  - `areas` は `AREAS` の定義順(実行順と同じ)。`fullCi` が非 null のときはその理由文字列で、`areas` / `benign` はそこまでに見た分だけ。
  - 評価順(設計 4.2): `BENIGN_FILES`(完全一致)→ 領域 `match` → `BENIGN_PREFIXES`(前方一致)→ どれにも当たらなければ `fullCi`。
- `export const AREAS`, `export const BENIGN_FILES`, `export const BENIGN_PREFIXES`(テストからの参照用)
- 新領域 `ci-machinery`: `match = p.startsWith('scripts/') || p.startsWith('.husky/')`、`stages: []`、label `CI 機構 (共有ゲートのみ)`
- `BENIGN_FILES = ['README.md', 'editor/README.md', 'pie-chart/README.md', '.gitignore']`。`.gitattributes` は含めない(Biome の eol 前提を変えるためフル fallback のまま)。
- `BENIGN_PREFIXES = ['docs/', '.github/']`

**Steps:**

- [ ] **RED**: `scripts/ci-affected.test.mjs` へテストを足す。ファイル冒頭の import に `classifyChanges` を加え、`planFor` の隣に stdout を返す `dryRunOutput` を置く

```diff
 import { fileURLToPath } from 'node:url';

+import { classifyChanges } from './ci-affected.mjs';
+
 const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
```

```diff
 function planForChanges(paths) {
   const { root, base } = buildFixtureRepo(paths);
   try {
     return planFor(root, ['--dry-run', '--base', base]);
   } finally {
     rmSync(root, { recursive: true, force: true });
   }
 }
+
+// dry-run の標準出力をそのまま返す。実行計画(`planFor`)には現れない「領域名の表示」を見る
+// テスト用(`ci-machinery` は stages が空なので計画には 1 行も出ない)。
+function dryRunOutput(paths) {
+  const { root, base } = buildFixtureRepo(paths);
+  try {
+    const res = spawnSync(
+      process.execPath,
+      [join(root, 'scripts', 'ci-affected.mjs'), '--dry-run', '--base', base],
+      { cwd: root, encoding: 'utf8' },
+    );
+    assert.equal(res.status, 0, res.stdout + res.stderr);
+    return res.stdout;
+  } finally {
+    rmSync(root, { recursive: true, force: true });
+  }
+}
```

  ファイル末尾へ追加:

```js
// ── 領域判定の純関数(git を経由しない) ──
// `classifyChanges` は「何が走るか」を決める唯一の関数で、上の dry-run テストは
// それを実行計画の形で見ている。ここでは判定そのものを直接固定する。

test('classifyChanges: scripts/ だけの変更は ci-machinery 領域(段は無し)', () => {
  assert.deepEqual(classifyChanges(['scripts/x.mjs']), {
    areas: ['ci-machinery'],
    benign: [],
    fullCi: null,
  });
});

test('classifyChanges: README だけの editor 変更は領域を発火しない', () => {
  // `editor/README.md` は editor 領域の `match` にも当たるが、BENIGN_FILES を領域判定より
  // 先に評価するので editor の typecheck / vitest / build / e2e は走らない。
  assert.deepEqual(classifyChanges(['editor/README.md']), {
    areas: [],
    benign: ['editor/README.md'],
    fullCi: null,
  });
});

test('classifyChanges: .gitattributes はフル CI へ倒れる', () => {
  // eol の前提は Biome の整形結果を全域で変えうるため、無害ファイルに含めない。
  const r = classifyChanges(['.gitattributes']);
  assert.equal(r.areas.length, 0);
  assert.match(r.fullCi, /\.gitattributes/);
});

test('classifyChanges: ルート README と editor ソースの同時変更は editor 領域だけ', () => {
  assert.deepEqual(classifyChanges(['README.md', 'editor/web/src/x.ts']), {
    areas: ['editor'],
    benign: ['README.md'],
    fullCi: null,
  });
});

test('scripts/ だけの変更は共有ゲートのみで、領域名は ci-machinery と表示される', () => {
  assert.deepEqual(planForChanges(['scripts/x.mjs']), SHARED_GATES);
  const out = dryRunOutput(['scripts/x.mjs']);
  assert.match(out, /実行領域: CI 機構 \(共有ゲートのみ\)/);
  assert.doesNotMatch(out, /変更領域なし/);
});

test('editor/README.md だけの変更は共有ゲートのみ', () => {
  assert.deepEqual(planForChanges(['editor/README.md']), SHARED_GATES);
});
```

- [ ] RED を確認する

```
node --test scripts/ci-affected.test.mjs
```

  期待: import 時点で `SyntaxError: The requested module './ci-affected.mjs' does not provide an export named 'classifyChanges'`(現行は export が無い)。加えて現行ファイルは import しただけで main が走る(`process.exit`)ので、ガード無しでは純関数テストが成立しないことも同時に分かる。

- [ ] **GREEN**: `scripts/ci-affected.mjs` を書き換える。① 領域定義の直後に `ci-machinery` を足し、`BENIGN_FILES` を新設、`BENIGN_PREFIXES` を縮小。② 判定を `classifyChanges` へ切り出す。③ 引数解釈と実行部を `main()` に入れ、argv ガードで囲む(`pre-push.mjs` と同じ形)。

  ①(1. 領域定義の末尾 〜 BENIGN 定義):

```diff
   docs: {
     label: 'docs (_build エンジン)',
     // 原稿(`docs/<project>/`)は下の BENIGN_PREFIXES へ落ちる。ここで拾うのは HTML 生成
     // エンジン側だけで、front-matter 解釈やトークン walker の退行は pytest でしか出ない。
     match: (p) => p.startsWith('docs/_build/'),
     stages: ['test:docs'],
   },
+  'ci-machinery': {
+    label: 'CI 機構 (共有ゲートのみ)',
+    // `scripts/` と `.husky/` は固有の段を持たない。`check:comments` と `test:scripts`
+    // (`ci-affected.test.mjs` を含む)は共有ゲートとして毎回走っており、フル `ci` が足す
+    // coverage / build / e2e は `scripts/` の正しさと無関係なのでフル fallback へは回さない。
+    // stages を空にした領域として持つのは、出力に領域名を出して「静かに何も走らなかった」
+    // 状態を作らないため。
+    match: (p) => p.startsWith('scripts/') || p.startsWith('.husky/'),
+    stages: [],
+  },
 };
-export const AREAS_ORDER = ...   // (無ければ何もしない。既存に無い行は足さない)
```

  (上の `AREAS_ORDER` 行は存在しないので無視する。`const AREAS` を `export const AREAS` にする。)

```diff
-// 領域 CI を持たない無害ディレクトリ。これらだけの変更なら共有ゲート(comments/biome)のみで足りる。
-// (`scripts`/`.github`/`.husky` は comments 検査が常時担保。)
-// `docs/` を残すのは原稿(`docs/<project>/src/*.md`・生成 HTML・画像)のためで、生成エンジン
-// (`docs/_build/`)は上の `docs` 領域が先に拾う(領域判定は BENIGN 判定より先に走る)。
-// 無害扱いにしてよいのは CI 領域を持たないディレクトリだけ。
-// `offline/` はここへ含めない: 署名検証・requirements 許可リストの実装本体
-// (offline/lib/verify.ps1)には固有の検査があり、無害入りしていた期間はその検査が
-// 1 段も起動しなかった(comments 検査は .ps1 の BOM/併設しか見ず、実装のロジックは見ない)。
-const BENIGN_PREFIXES = ['docs/', 'scripts/', '.github/', '.husky/'];
+// 単独で変わっても領域 CI を要しないファイル(完全一致)。**領域判定より先に**評価する:
+// `editor/README.md` は editor 領域の `match` にも当たるが、README だけの修正で editor の
+// typecheck / vitest / build / e2e を走らせない。`.gitattributes` は含めない(eol の前提が
+// 変わると Biome の整形結果が全域で動きうるので、フル fallback に倒す)。
+export const BENIGN_FILES = new Set(['README.md', 'editor/README.md', 'pie-chart/README.md', '.gitignore']);
+
+// 領域 CI を持たない無害ディレクトリ(前方一致)。これらだけの変更なら共有ゲート
+// (comments/biome/test:scripts)のみで足りる。
+// `docs/` を残すのは原稿(`docs/<project>/src/*.md`・生成 HTML・画像)のためで、生成エンジン
+// (`docs/_build/`)は上の `docs` 領域が先に拾う(領域判定は BENIGN_PREFIXES より先に走る)。
+// 無害扱いにしてよいのは CI 領域を持たないディレクトリだけ。
+// `offline/` はここへ含めない: 署名検証・requirements 許可リストの実装本体
+// (offline/lib/verify.ps1)には固有の検査があり、無害入りしていると 1 段も起動しない
+// (comments 検査は .ps1 の BOM/併設しか見ず、実装のロジックは見ない)。
+// `scripts/` / `.husky/` は上の `ci-machinery` 領域が拾う(ここに置くと出力に現れない)。
+export const BENIGN_PREFIXES = ['docs/', '.github/'];
+
+/**
+ * 変更パスの配列から実行計画の材料を決める。`areas` は `AREAS` の定義順(= 実行順)。
+ * どの判定にも当たらないパスを見つけた時点で `fullCi` に理由を入れて返す(以降のパスは
+ * 見ない。影響範囲が読めない変更が 1 つでもあればフル `ci` なので、続きを見る意味が無い)。
+ * git を呼ばない純関数で、`ci-affected.test.mjs` がここを直接固定する。
+ */
+export function classifyChanges(paths) {
+  const selected = new Set();
+  const benign = [];
+  for (const p of paths) {
+    if (BENIGN_FILES.has(p)) {
+      benign.push(p);
+      continue;
+    }
+    const area = Object.keys(AREAS).find((k) => AREAS[k].match(p));
+    if (area) {
+      selected.add(area);
+      continue;
+    }
+    if (BENIGN_PREFIXES.some((pre) => p.startsWith(pre))) {
+      benign.push(p);
+      continue;
+    }
+    // 例: package.json / pnpm-lock.yaml / pnpm-workspace.yaml / vitest.config.ts / tsconfig* /
+    //     biome.* / .nvmrc / .gitattributes 等。影響範囲が全域に及び得るため安全側に倒す。
+    return {
+      areas: Object.keys(AREAS).filter((a) => selected.has(a)),
+      benign,
+      fullCi: `領域に紐付かない共有変更を検出 (${p})`,
+    };
+  }
+  return { areas: Object.keys(AREAS).filter((a) => selected.has(a)), benign, fullCi: null };
+}
```

  ②③(2. 以降を `main()` にまとめる。`argv` / `DRY` はモジュール直下のまま残してよい — import 時に副作用が無い純粋な読み取りなので、テストからの import で困らない。副作用があるのは `git(...)` 以降だけ):

```diff
 // ── 4. メイン ──
-if (argv.includes('--all')) runFullCi('--all 指定');
-
-const base = resolveBase();
-if (!base) runFullCi('ベース ref を解決できませんでした');
-
-const diffRange = `${base}...HEAD`;
-// `-c core.quotePath=false`: ...(既存コメントは main 内へそのまま移す)
-const out = git(['-c', 'core.quotePath=false', 'diff', '--name-only', diffRange], { allowFail: true });
-if (out === null) runFullCi(`git diff ${diffRange} に失敗しました`);
-
-const changed = out.split('\n').filter(Boolean);
-console.log(`[ci:affected] ベース: ${base}  (${diffRange})`);
-console.log(`[ci:affected] 変更ファイル数: ${changed.length}`);
-console.log('[ci:affected] 注: coverage 85% ゲートはフル `pnpm run ci` でのみ検査します (affected/領域別は速度優先で対象外)');
-
-// 領域マッピング。無害でも領域でもないルート直下/共有変更を見つけたらフル CI へ。
-const selected = new Set();
-for (const p of changed) {
-  const area = Object.keys(AREAS).find((k) => AREAS[k].match(p));
-  if (area) {
-    selected.add(area);
-    continue;
-  }
-  if (BENIGN_PREFIXES.some((pre) => p.startsWith(pre))) continue;
-  // 例: package.json / pnpm-lock.yaml / pnpm-workspace.yaml / vitest.config.ts / tsconfig* /
-  //     biome.* / .nvmrc 等。影響範囲が全域に及び得るため安全側に倒す。
-  runFullCi(`領域に紐付かない共有変更を検出 (${p})`);
-}
-
-// ── 5. 実行計画の可視化と実行 ──
-const allAreas = Object.keys(AREAS);
-const skipped = allAreas.filter((a) => !selected.has(a));
-console.log(`[ci:affected] 実行領域: ${selected.size ? [...selected].map((a) => AREAS[a].label).join(', ') : '(なし)'}`);
-console.log(`[ci:affected] スキップ領域: ${skipped.length ? skipped.map((a) => AREAS[a].label).join(', ') : '(なし)'}`);
-
-// 共有ゲートは...(既存コメント)
-runPnpm('check:comments');
-runPnpm('check:claude-hooks');
-runPnpm('check:ci');
-runPnpm('test:scripts');
-
-if (selected.size === 0) {
-  console.log('\n[ci:affected] 変更領域なし。共有ゲートのみで完了。');
-  process.exit(0);
-}
-
-// 領域ごとに typecheck → test →(editor のみ)build → e2e。順序は AREAS の stages 定義どおり。
-for (const area of allAreas.filter((a) => selected.has(a))) {
-  for (const stage of AREAS[area].stages) runPnpm(stage);
-}
-
-console.log('\n[ci:affected] 完了。');
+// 直接起動時のみ実行する。テストは `classifyChanges` を import するだけで git に触れない。
+if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
+  main();
+}
+
+function main() {
+  if (argv.includes('--all')) runFullCi('--all 指定');
+
+  const base = resolveBase();
+  if (!base) runFullCi('ベース ref を解決できませんでした');
+
+  const diffRange = `${base}...HEAD`;
+  // `-c core.quotePath=false`: 非 ASCII パスの八進エスケープ＋引用符付き出力(`"docs/…\346…"`)を
+  // 無効化し、UTF-8 リテラルで受け取る。これが無いと `p.startsWith('docs/')` 等の BENIGN 判定が
+  // 外れ、docs だけの変更でも不要にフル `ci` へフォールバックしてしまう。
+  const out = git(['-c', 'core.quotePath=false', 'diff', '--name-only', diffRange], { allowFail: true });
+  if (out === null) runFullCi(`git diff ${diffRange} に失敗しました`);
+
+  const changed = out.split('\n').filter(Boolean);
+  console.log(`[ci:affected] ベース: ${base}  (${diffRange})`);
+  console.log(`[ci:affected] 変更ファイル数: ${changed.length}`);
+  console.log('[ci:affected] 注: coverage 85% ゲートはフル `pnpm run ci` でのみ検査します (affected/領域別は速度優先で対象外)');
+
+  // 領域マッピング。無害でも領域でもないルート直下/共有変更を見つけたらフル CI へ。
+  const { areas, benign, fullCi } = classifyChanges(changed);
+  if (fullCi) runFullCi(fullCi);
+
+  // ── 5. 実行計画の可視化と実行 ──
+  const selected = new Set(areas);
+  const skipped = Object.keys(AREAS).filter((a) => !selected.has(a));
+  console.log(`[ci:affected] 実行領域: ${areas.length ? areas.map((a) => AREAS[a].label).join(', ') : '(なし)'}`);
+  console.log(`[ci:affected] スキップ領域: ${skipped.length ? skipped.map((a) => AREAS[a].label).join(', ') : '(なし)'}`);
+  if (benign.length) console.log(`[ci:affected] 領域 CI 不要の変更: ${benign.length} 件 (${benign.join(', ')})`);
+
+  // 共有ゲートは領域の有無に関わらず 1 回だけ実行(comments は .ps1/.md 等も検査するため常時必要)。
+  // claude-hooks も同列: `.claude/` は git 追跡外で diff に現れないため領域発火の対象にできず、
+  // diff の中身に関わらず常時検査する側に置くしかない。test:scripts も同列: `scripts/` の
+  // `ci-machinery` 領域は段を持たず、`scripts/*.test.mjs` はここで常時実行する。
+  runPnpm('check:comments');
+  runPnpm('check:claude-hooks');
+  runPnpm('check:ci');
+  runPnpm('test:scripts');
+
+  if (areas.length === 0) {
+    console.log('\n[ci:affected] 変更領域なし。共有ゲートのみで完了。');
+    process.exit(0);
+  }
+
+  // 領域ごとに typecheck → test →(editor のみ)build → e2e。順序は AREAS の stages 定義どおり。
+  for (const area of areas) {
+    for (const stage of AREAS[area].stages) runPnpm(stage);
+  }
+
+  console.log('\n[ci:affected] 完了。');
+}
```

  `function` 宣言は hoisting で `main()` の前に置いた呼び出しから見えるが、`runPnpm` / `runFullCi` / `resolveBase` / `git` は既存位置(3. と 2.)のまま `main` より上にあるので順序は気にしなくてよい。ファイル冒頭の「安全側の判断」コメントに 1 行足す:

```diff
 //   - 何が走り何をスキップしたかを冒頭に出力する(silent に絞ったように見せない)。
+//   - README / `.gitignore` だけの変更は領域 CI を起こさない(`BENIGN_FILES`)。`scripts/` /
+//     `.husky/` は段を持たない領域 `ci-machinery` として出力に名前を出す。
```

- [ ] GREEN を確認する

```
node --test scripts/ci-affected.test.mjs
```

  期待: `# tests 14` / `# pass 14` / `# fail 0`(既存 8 + 追加 6)。特に `docs 原稿だけの変更は共有ゲートのみ` と `複数領域の変更は領域定義の順に連結される` が引き続き緑(`docs/` の扱いと領域順序が不変)。

- [ ] 実リポジトリに対する dry-run で表示を目視する

```
node scripts/ci-affected.mjs --dry-run --base HEAD~1
```

  期待(直前コミットが `package.json` 変更の C1 なら): `[ci:affected] 領域に紐付かない共有変更を検出 (package.json) → フル \`ci\` を実行します。` の後に `(dry-run) pnpm run ci` / `(dry-run) pnpm run ci:offline`。

- [ ] コミット

```
git add scripts/ci-affected.mjs scripts/ci-affected.test.mjs
git commit -m "chore(ci): affected の領域判定を純関数へ切り出し README 単独変更と scripts/ を明示的に扱う

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---

### Task C3: `ci.yml` の段が `ci` の部分列であることを機械検査する(C4 と同一コミット)

**Files:**
- 変更: `scripts/ci-affected.test.mjs`(yml 行パーサ + 写像 + 免除リスト + 順序検査)

**Interfaces:**
- テスト内ローカル関数(export しない): `parseWorkflowSteps(text) → { name, run }[]`、`stagesOfRun(run) → string[]`、`ciStages() → string[]`
- 免除(設計 4.3 の表): `check:claude-hooks`、`pie-chart:batch`、`pie-chart:batch:diff`。`ci:offline` は `ci` にも yml にも無いことを別途固定する。

**Steps:**

- [ ] **RED**: `scripts/ci-affected.test.mjs` の末尾へ追加する。import に `readFileSync` を足す

```diff
-import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
+import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

```js
// ── GitHub Actions の段と `ci` の同期 ──
// `.github/workflows/ci.yml` は `pnpm run ci` と同じ段を並べる決まりだが、手で同期している限り
// 片方だけに足した段は静かに抜ける(実例: `test:scripts` が yml に無かった)。yml を行ベースで
// 読み、各 step の `run:` を `package.json` の script 名へ写像して「yml の段 ⊆ ci の段」と
// 「相対順序が同じ」を固定する。YAML パーサはルートから import できないので使わない。

const CI_YML = join(REAL_ROOT, '.github', 'workflows', 'ci.yml');

/**
 * `- name:` で step を区切り、`run:` の値を返す。`run: |` の継続行は 1 つの文字列に連結する
 * (行はインデントが `run:` より深い間だけ続く)。`- uses:` だけの step は `run` を持たない。
 */
function parseWorkflowSteps(text) {
  const steps = [];
  let cur = null;
  let block = null; // { indent } — `run: |` の継続行を読んでいる間だけ非 null
  for (const raw of text.split(/\r?\n/)) {
    const indent = raw.match(/^ */)[0].length;
    if (block) {
      if (raw.trim() === '' || indent > block.indent) {
        if (raw.trim() !== '') cur.run = cur.run ? `${cur.run}\n${raw.trim()}` : raw.trim();
        continue;
      }
      block = null;
    }
    const item = raw.match(/^ *- (name|uses):\s*(.*?)\s*$/);
    if (item) {
      cur = { name: item[1] === 'name' ? item[2] : `(uses) ${item[2]}`, run: null };
      steps.push(cur);
      continue;
    }
    const run = cur && raw.match(/^( *)run:\s*(.*?)\s*$/);
    if (run) {
      if (run[2] === '|' || run[2] === '>') {
        block = { indent: run[1].length };
        cur.run = '';
      } else {
        cur.run = run[2];
      }
    }
  }
  return steps;
}

// yml の `run` 1 行 → `ci` の段名。導入系(pnpm install / playwright install / pip install)と
// キャッシュ鍵の解決(`echo "version=…"`)は段ではない。写像に無いコマンドは例外にする —
// 新しい step を足したらこの表を更新する、が同期の手順そのもの。
const RUN_TO_STAGE = [
  [/^pnpm run (\S+)$/, (m) => m[1]],
  [/^python scripts\/check-comments\.py$/, () => 'check:comments'],
  [/^python -m pytest docs\/_build$/, () => 'test:docs'],
];
const NON_STAGE_RUN = /^(pnpm install\b|pnpm exec playwright install\b|pip install\b|echo "version=)/;

function stagesOfRun(run) {
  const stages = [];
  for (const line of run.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (NON_STAGE_RUN.test(line)) continue;
    const hit = RUN_TO_STAGE.find(([re]) => re.test(line));
    if (!hit) throw new Error(`ci.yml の run を段へ写像できません: ${line}`);
    stages.push(hit[1](line.match(hit[0])));
  }
  return stages;
}

function ciStages() {
  const pkg = JSON.parse(readFileSync(join(REAL_ROOT, 'package.json'), 'utf8'));
  return pkg.scripts.ci.split('&&').map((s) => s.trim().replace(/^pnpm run /, ''));
}

// `ci` にあって GH に無い段。理由が消えたらここから外して yml へ足す。
const GH_EXEMPT = {
  'check:claude-hooks': '.claude/ は git 追跡外で、GH の checkout には検査対象が無い(exit 0 になるだけ)',
  'pie-chart:batch': 'out/_baseline はローカル生成物で GH に存在しない',
  'pie-chart:batch:diff': 'out/_baseline はローカル生成物で GH に存在しない',
};

test('ci.yml の段は ci の段の部分列で、免除リスト外の欠落が無い', () => {
  const ci = ciStages();
  const yml = parseWorkflowSteps(readFileSync(CI_YML, 'utf8'))
    .filter((s) => s.run !== null)
    .flatMap((s) => stagesOfRun(s.run));
  assert.ok(yml.length > 0, 'yml から段を 1 つも読めていない(パーサか yml の形が変わった)');

  // yml ⊆ ci
  const unknown = yml.filter((s) => !ci.includes(s));
  assert.deepEqual(unknown, [], `ci に無い段が yml にある: ${unknown.join(', ')}`);

  // ci − yml ⊆ 免除
  const missing = ci.filter((s) => !yml.includes(s) && !(s in GH_EXEMPT));
  assert.deepEqual(missing, [], `yml に無く免除もされていない段: ${missing.join(', ')}`);

  // 免除は生きているものだけ(ci から消えた段を免除し続けない)
  for (const s of Object.keys(GH_EXEMPT)) assert.ok(ci.includes(s), `免除 ${s} は ci に無い`);

  // 相対順序: yml の段を ci の添字に写すと単調増加
  const idx = yml.map((s) => ci.indexOf(s));
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `yml の順序が ci と違う: ${yml[i - 1]} → ${yml[i]}`);
  }
});

test('ci:offline は ci にも ci.yml にも無い(Windows 限定の Pester は runFullCi が別途呼ぶ)', () => {
  assert.ok(!ciStages().includes('ci:offline'));
  const text = readFileSync(CI_YML, 'utf8');
  assert.doesNotMatch(text, /ci:offline/);
});

test('parseWorkflowSteps は run: | の継続行を連結し uses だけの step を run 無しにする', () => {
  const steps = parseWorkflowSteps(
    [
      '      - uses: actions/checkout@abc # v5',
      '        with:',
      '          persist-credentials: false',
      '      - name: A',
      '        run: pnpm run check:ci',
      '      - name: B',
      '        run: |',
      '          pip install -r x.txt',
      '          python -m pytest docs/_build',
      '      - name: C',
      '        uses: actions/upload-artifact@def # v7',
    ].join('\n'),
  );
  assert.deepEqual(
    steps.map((s) => [s.name, s.run]),
    [
      ['(uses) actions/checkout@abc # v5', null],
      ['A', 'pnpm run check:ci'],
      ['B', 'pip install -r x.txt\npython -m pytest docs/_build'],
      ['C', null],
    ],
  );
  assert.deepEqual(stagesOfRun(steps[2].run), ['test:docs']);
});
```

- [ ] RED を確認する

```
node --test scripts/ci-affected.test.mjs
```

  期待: `ci.yml の段は ci の段の部分列で…` が赤。理由は 2 つ同時に出るはず — ① `yml に無く免除もされていない段: test:scripts`(現行 yml に無い)、より前に ② 順序検査の前段で `unknown` は空、`missing` で止まる。C4 で yml を直すまでこの赤は消えない(**C4 を同じコミットに入れる**)。`parseWorkflowSteps` の単体テストと `ci:offline` のテストは緑。

- [ ] C4 を実施してから、まとめて GREEN を確認する(C4 末尾)。

---

### Task C4: `ci.yml` を `ci` と同じ順に並べ替え、`test:scripts` / concurrency / timeout / Playwright キャッシュを足す(C3 と同一コミット)

**Files:**
- 変更: `.github/workflows/ci.yml`

**Interfaces:**
- step の順(段だけ抜き出すと C1 の `ci` から免除 3 段を除いた列): `check:comments → check:ci → test:scripts → typecheck → test:coverage → test:docs → build → test:e2e`
- `concurrency.group = ci-${{ github.event.pull_request.number || github.ref }}`、`cancel-in-progress = ${{ github.event_name == 'pull_request' }}`
- `jobs.verify.timeout-minutes: 30`
- `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0`(`gh api repos/actions/cache/git/ref/tags/v6.1.0` で解決済み。`type: commit`、`action.yml` は `using: node24` で checkout v5.1.0 と同じランタイム)。鍵は `pnpm-lock.yaml` の `'@playwright/test@<版>':` 行から `sed` で取る(このリポジトリで `1.62.1` が取れることを確認済み)。

**Steps:**

- [ ] `.github/workflows/ci.yml` を次の内容にする(全文。既存の日本語コメントは保ち、追加分は同じ調子で書く)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# 同じ PR / ブランチの古い run は新しい push で打ち切る。PR 以外(main への push)は打ち切らず
# 直列に流す — main の履歴に「途中で消えた run」を残さないため。
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

# 既定の GITHUB_TOKEN は読み取りだけに絞る。この job は検査しかしないため書き込み権限は不要で、
# 依存やアクションの侵害でトークンが悪用されても push / release へは届かない。
permissions:
  contents: read

# アクションは可変タグでなく**コミット SHA で pin** する。`@v5` のようなタグは指す先が
# 動くため、上流のタグ移動 1 つで CI ランナー上の任意コード実行に到達する。版は末尾の
# コメントで残し、更新時は SHA とコメントの両方を書き換える。
#
# step の並びは `package.json` の `ci` と同じ順に保つ(`scripts/ci-affected.test.mjs` が
# 「yml の段 ⊆ ci の段・同じ相対順序」を機械検査する。段を足す/外すときはその写像表も更新する)。
# `ci` にあってここに無い段は同テストの免除リストに理由付きで載せる:
#   - `check:claude-hooks`: `.claude/` は git 追跡外で checkout に検査対象が無い。
#   - `pie-chart:batch` / `pie-chart:batch:diff`: `out/_baseline` はローカル生成物で GH に無い。
#
# offline/ の Pester テスト(`pnpm run ci:offline`)はここでは実行しない: Windows ランナーへの
# 切替が要り、この job は ubuntu-latest 前提のため。ローカルの `ci:affected`(offline/ 変更時に
# 発火)で担保する。
jobs:
  verify:
    runs-on: ubuntu-latest
    # ローカルのフル `ci` は 10 分未満が目標。ランナーの cold(依存導入・ブラウザ導入込み)でも
    # 30 分を超えるのは hang なので打ち切る。
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          # この job は remote へ git しない。既定では checkout が認証情報を
          # .git/config へ残すため、後続ステップ（依存のビルドスクリプト等）から
          # トークンを使われないよう明示的に無効化する。
          persist-credentials: false

      - name: Setup pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
        with:
          standalone: true

      - name: Setup Node
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # Python は `check:comments`(先頭の段)から要るので、導入は全部ここで済ませる。
      - name: Setup Python
        uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: '3.13'

      - name: Install Python test dependencies
        run: pip install -r docs/_build/requirements.txt -r docs/_build/dev-requirements.txt

      - name: Comment convention check
        run: python scripts/check-comments.py

      - name: Lint & format check (Biome)
        run: pnpm run check:ci

      - name: Test (scripts, node:test)
        run: pnpm run test:scripts

      - name: Typecheck
        run: pnpm run typecheck

      - name: Test (with coverage thresholds)
        run: pnpm run test:coverage

      - name: Test (pytest - docs)
        run: python -m pytest docs/_build

      - name: Build
        run: pnpm run build

      # ブラウザ本体(約 150MB)は `@playwright/test` の版が同じ限り不変なので、版を鍵に
      # キャッシュする。版は lockfile から読む(`node_modules` から読むと frozen-lockfile と
      # 二重に真実を持つことになる)。`playwright install` は既に在るブラウザを飛ばし、
      # `--with-deps` の OS パッケージだけを毎回入れる。
      - name: Resolve Playwright version
        id: playwright
        run: |
          echo "version=$(sed -n "s/^  '@playwright\/test@\([^']*\)':.*/\1/p" pnpm-lock.yaml | head -n1)" >> "$GITHUB_OUTPUT"

      - name: Cache Playwright browsers
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ steps.playwright.outputs.version }}

      - name: Install Playwright browsers
        run: pnpm exec playwright install --with-deps chromium

      - name: E2E (Playwright)
        run: pnpm run test:e2e

      - name: Upload Playwright report
        if: ${{ !cancelled() }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

  変更点の要約: ① `concurrency` と `timeout-minutes` を追加、② `Setup Python` と `pip install` を `Install dependencies` の直後へ前倒し、`Comment convention check` を最初の段に、③ `Test (scripts, node:test)` を追加、④ `Test (pytest - docs)` を coverage の後・build の前へ、⑤ Playwright の版解決 + キャッシュを追加。`upload-artifact` は段ではない(run を持たない)ので検査対象外。

- [ ] `sed` の版抽出がこのリポジトリで期待どおりであることを確認する(Git Bash で)

```
sed -n "s/^  '@playwright\/test@\([^']*\)':.*/\1/p" pnpm-lock.yaml | head -n1
```

  期待出力: `1.62.1`(`pnpm-lock.yaml` の `packages:` 節の `'@playwright/test@1.62.1':` 行から)。

- [ ] C3 のテストを含めて GREEN を確認する

```
node --test scripts/ci-affected.test.mjs
```

  期待: `# tests 17` / `# pass 17` / `# fail 0`。`ci.yml の段は ci の段の部分列で…` が緑(yml の段列 = `check:comments, check:ci, test:scripts, typecheck, test:coverage, test:docs, build, test:e2e`、免除 3 段を除いて `ci` と一致)。

- [ ] yml の構文だけ機械確認する(actionlint は無いので YAML として読めることのみ。`py -3.13` の PyYAML は docs ビルドの依存で入っている)

```
py -3.13 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml',encoding='utf-8')); print(d['concurrency']); print(d['jobs']['verify']['timeout-minutes']); print([s.get('name') for s in d['jobs']['verify']['steps']])"
```

  期待出力(`on` は YAML 1.1 で `True` キーに化けるが今回は読まない):

```
{'group': 'ci-${{ github.event.pull_request.number || github.ref }}', 'cancel-in-progress': '${{ github.event_name == 'pull_request' }}'}
30
[None, 'Setup pnpm', 'Setup Node', 'Install dependencies', 'Setup Python', 'Install Python test dependencies', 'Comment convention check', 'Lint & format check (Biome)', 'Test (scripts, node:test)', 'Typecheck', 'Test (with coverage thresholds)', 'Test (pytest - docs)', 'Build', 'Resolve Playwright version', 'Cache Playwright browsers', 'Install Playwright browsers', 'E2E (Playwright)', 'Upload Playwright report']
```

- [ ] コミット(C3 と一緒)

```
git add scripts/ci-affected.test.mjs .github/workflows/ci.yml
git commit -m "ci: GitHub Actions の段を ci と同じ順にし test:scripts・concurrency・Playwright キャッシュを足して部分列検査で固定する

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

  push 後、GH の run で `Cache Playwright browsers` が初回 `Cache not found for input keys: playwright-Linux-1.62.1` → 2 回目 `Cache restored from key: playwright-Linux-1.62.1` になることを確認する(`gh run view --log` で該当 step を見る)。

---

### Task C5: `test:e2e` の直前に 24680 / 24681 が空いていることを確かめる(設計 10.1)

#### 設計判断(なぜ新しい `scripts/check-ports.mjs` か)

候補と却下理由:

| 案 | 却下理由 |
|---|---|
| `playwright.config.ts` で `reuseExistingServer` を環境変数で切り、`test:e2e` に `E2E_FRESH=1` を前置する | Windows の pnpm script は cmd で走り(`.npmrc` に `shell-emulator` 無し)`X=1 cmd` 形が使えない。`shell-emulator=true` にすると `ci:offline` の PowerShell 文字列内 `$m` / `$c` が展開されて壊れる。`cross-env` は新規依存 = オフライン重量物バンドルの再生成 |
| `package.json` に `node -e "…"` を書く | JSON の中に約 200 文字の JS が入り、テストできず、失敗理由の日本語文言も置けない |
| `scripts/ci-affected.mjs` のサブコマンド(`--check-ports`) | affected ランナーは `ci` から呼ばれる側ではなく呼ぶ側で、`ci` チェーンの部品を同居させると役割が逆転する。フィクスチャ複製テストの対象にも巻き込まれる |
| Python(`scripts/check-ports.py`) | `test:e2e` は GH でも `pnpm run` 経由で走り、ubuntu に `py` ランチャは無い(`check:comments` が GH で `python` 直呼びなのはこの理由)。チームの Python 第一は「新規ツール」の規則で、Node ツールチェーン(playwright)の直前ガードには Node 側に置くほうが依存の向きが自然 |

採用: **`scripts/check-ports.mjs`(約 25 行 + 起動ガード)+ `scripts/check-ports.test.mjs`(`node:test`)を `test:scripts` に加える**。Node の `.mjs` を新規に増やす例外だが、理由は上記 2 点(GH の `pnpm run` 経路で Python ランチャが無い / playwright 直前の Node 側ガード)で、`scripts/` の既存 4 本と同じ書式・同じテストハーネスに収まる。

**判定は bind でなく connect で行う**(このパートで実測した事実): Windows では `net.createServer().listen(port)`(ワイルドカード)が `127.0.0.1` / `::1` に居る listener と**衝突しない**(`LISTEN_OK` が返る)ため、bind の成否は「空いている」の証拠にならない。一方 connect は listener の族と一致した時だけ成功し、Fastify は `127.0.0.1`(`config.ts` の既定)、Vite は `localhost` = この端末では `::1` で待つので、**両アドレスへ接続を試みてどちらかが応じれば使用中**とする。これは playwright の `reuseExistingServer` が URL 到達性で判定するのと同じ述語で、「playwright なら再利用していた」状況だけを正確に落とす。

**Files:**
- 新規: `scripts/check-ports.mjs`
- 新規: `scripts/check-ports.test.mjs`
- 変更: `package.json`(`test:scripts` に追加、`test:e2e` の先頭に前置)

**Interfaces:**
- `export function isListening(port: number, host: string, timeoutMs = 1000): Promise<boolean>`
- `export async function findBusyPorts(ports: number[]): Promise<{ port: number; host: string }[]>`
- CLI: `node scripts/check-ports.mjs <port> [<port> ...]` — 全部空きなら exit 0、使用中があれば理由を stderr に出して exit 1、引数不正は exit 2
- `test:e2e` = `node scripts/check-ports.mjs 24680 24681 && playwright test -c editor/playwright.config.ts`(P タスクが `--project chromium` を末尾に足す。既に入っていれば残す)
- `e2e:editor`(pre-push の editor 領域)には**前置しない**: 開発中の dev サーバを再利用するのが pre-push の意図で、設計 10.1 の要求は `pnpm run ci` に限る

**Steps:**

- [ ] **RED**: `scripts/check-ports.test.mjs` を作る

```js
// =============================================================================
// check-ports.test.mjs — ポート使用中の判定を loopback の両アドレスで固定する
// =============================================================================
// 判定を bind でなく connect で行う理由は `check-ports.mjs` 冒頭にある。ここで守るのは
// 「`127.0.0.1` だけで待つ listener」「`::1` だけで待つ listener」のどちらも使用中と判定し、
// listener を閉じたら空きに戻ること。CLI は使用中のとき exit 1 と日本語の理由を出す。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findBusyPorts, isListening } from './check-ports.mjs';

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url))), 'check-ports.mjs');

// 指定 host で空きポートに listen し、`{ port, close }` を返す。host が使えない環境
// (IPv6 無効で `::1` に bind できない等)は null。
function listenOn(host) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once('error', () => done(null));
    srv.listen({ port: 0, host }, () => {
      done({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

for (const host of ['127.0.0.1', '::1']) {
  test(`${host} だけで待つ listener を使用中と判定し、閉じたら空きに戻る`, async (t) => {
    const l = await listenOn(host);
    if (!l) return t.skip(`${host} に bind できない環境`);
    try {
      assert.deepEqual(await findBusyPorts([l.port]), [{ port: l.port, host }]);
      assert.equal(await isListening(l.port, host), true);
    } finally {
      await l.close();
    }
    assert.deepEqual(await findBusyPorts([l.port]), []);
  });
}

test('CLI は使用中のポートがあると exit 1 で理由を出す', async () => {
  const l = await listenOn('127.0.0.1');
  try {
    const res = spawnSync(process.execPath, [SCRIPT, String(l.port)], { encoding: 'utf8' });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, new RegExp(`使用中: 127\\.0\\.0\\.1:${l.port}`));
    assert.match(res.stderr, /古いコードのサーバ/);
  } finally {
    await l.close();
  }
});

test('CLI は全部空きなら exit 0', async () => {
  const l = await listenOn('127.0.0.1');
  const port = l.port;
  await l.close(); // 直前まで使っていたポートは今は空き
  const res = spawnSync(process.execPath, [SCRIPT, String(port)], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp(`空き: ${port}`));
});

test('CLI は引数が無い/数値でないと exit 2', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'abc'], { encoding: 'utf8' }).status, 2);
});
```

- [ ] RED を確認する

```
node --test scripts/check-ports.test.mjs
```

  期待: `Cannot find module '.../scripts/check-ports.mjs'` で全件失敗。

- [ ] **GREEN**: `scripts/check-ports.mjs` を作る

```js
// =============================================================================
// check-ports.mjs — e2e の直前に webServer 用ポートが空いていることを確かめる
// =============================================================================
// playwright の `reuseExistingServer` は URL が応答すれば既存サーバを使い回す。前回の e2e や
// 開発中の dev サーバが 24680 / 24681 に残っていると、`pnpm run ci` の e2e が**古いコードの
// サーバ**に対して走り、緑でも今のツリーを検証していない。`ci` の e2e は必ず自分で起動した
// サーバで走らせるため、残っていれば理由付きで落とす(`test:e2e` の先頭で呼ぶ)。
//
// 判定は bind でなく **connect** で行う。Windows ではワイルドカードの bind が `127.0.0.1` /
// `::1` に居る listener と衝突しない(listen が成功する)ため、bind の成否は「空いている」の
// 証拠にならない。loopback の両アドレスへ接続を試み、どちらかが応じれば使用中とみなす
// (Fastify は `127.0.0.1`、Vite は `localhost` = 環境により `::1` で待つ)。これは playwright が
// 再利用を決める述語(URL への到達性)と同じなので、「再利用されていたはず」の状況だけを落とす。

import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACKS = ['127.0.0.1', '::1'];

/** `host:port` へ TCP 接続できれば true(= 誰かが待ち受けている)。拒否・到達不能・timeout は false。 */
export function isListening(port, host, timeoutMs = 1000) {
  return new Promise((done) => {
    const sock = connect({ port, host });
    const finish = (listening) => {
      sock.destroy();
      done(listening);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 使用中の `{ port, host }` を列挙する(空配列なら全部空き)。 */
export async function findBusyPorts(ports) {
  const busy = [];
  for (const port of ports) {
    for (const host of LOOPBACKS) {
      if (await isListening(port, host)) busy.push({ port, host });
    }
  }
  return busy;
}

// ── 実行部(直接起動時のみ。テストからの import では走らせない) ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ports = process.argv.slice(2).map(Number);
  if (ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    console.error('使い方: node scripts/check-ports.mjs <port> [<port> ...]');
    process.exit(2);
  }
  const busy = await findBusyPorts(ports);
  if (busy.length > 0) {
    console.error(`[check-ports] 使用中: ${busy.map((b) => `${b.host}:${b.port}`).join(', ')}`);
    console.error(
      '[check-ports] 前回の e2e か開発中の dev サーバが残っています。このまま e2e を走らせると' +
        '古いコードのサーバを再利用するため中止します。サーバを停止してから再実行してください。',
    );
    process.exit(1);
  }
  console.log(`[check-ports] 空き: ${ports.join(', ')}`);
}
```

  (トップレベル `await` は ESM で使える。`process.exit` 前に `console.error` が flush されるのは stderr が同期のため。)

- [ ] GREEN を確認する

```
node --test scripts/check-ports.test.mjs
```

  期待: `# tests 5` / `# pass 5`(IPv6 が無い環境では `::1` の 1 件が `# skipped 1`)。

- [ ] `package.json` を書き換える

```diff
-    "test:e2e": "playwright test -c editor/playwright.config.ts",
+    "test:e2e": "node scripts/check-ports.mjs 24680 24681 && playwright test -c editor/playwright.config.ts",
```

  (P タスクが先に入っていて末尾に `--project chromium` があればそのまま残す。)

```diff
-    "test:scripts": "node --test scripts/clean.test.mjs scripts/ci-affected.test.mjs scripts/pre-push.test.mjs",
+    "test:scripts": "node --test scripts/clean.test.mjs scripts/ci-affected.test.mjs scripts/pre-push.test.mjs scripts/check-ports.test.mjs",
```

- [ ] 実機で「残ったサーバがあると落ちる」ことを 1 回見る

```
pnpm --filter server run dev
```

  別の端末で:

```
pnpm run test:e2e
```

  期待: playwright が起動する前に stderr へ `[check-ports] 使用中: 127.0.0.1:24680` と理由 1 行が出て exit 1(pnpm は `ELIFECYCLE  Command failed with exit code 1`)。dev サーバを止めてから再実行すると `[check-ports] 空き: 24680, 24681` の後に playwright が自分でサーバを起動して走る。

- [ ] コメント規約の機械検査(装飾ボックスヘッダ)と scripts テスト全体

```
pnpm run check:comments
pnpm run test:scripts
```

  期待: `check:comments` で新規 2 ファイルに関する警告なし。`test:scripts` は `# fail 0`(C1〜C4 の 17 + 5 = 22 件通過)。

- [ ] コミット

```
git add scripts/check-ports.mjs scripts/check-ports.test.mjs package.json
git commit -m "chore(ci): test:e2e の直前に 24680/24681 が空いていることを loopback 両アドレスへの接続で確かめる

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---

### Task C6: ルート README に「clone 直後のフル `ci` には `baseline:accept` が要る」を書く

**Files:**
- 変更: `README.md`(「主な pnpm コマンド」表の `pnpm run ci` 行 + 「CI の分割と coverage ゲート」節の直後に小節を追加)

**Interfaces:** なし(文書のみ)。正典の所在: 手順の実体は `pie-chart/README.md`「検証」節(baseline の初回作成)で、README はそこへ誘導する 1 段落に留める(コメント規約の「重複は集約」)。

**Steps:**

- [ ] 表の行を 1 つ書き換える

```diff
-| `pnpm run ci` | CI 集約（全領域＋coverage 85% 閾値ゲート） |
+| `pnpm run ci` | CI 集約（全領域＋coverage 85% 閾値ゲート＋pie-chart の SVG byte 比較。clone 直後は下記「フル `ci` の前提」を先に） |
```

- [ ] 「CI の分割と coverage ゲート」節の末尾(`> **注意:** …` の引用ブロックの後)に小節を足す

```markdown
#### フル `ci` の前提（clone 直後に 1 回）

`pnpm run ci` は `pie-chart:batch` → `pie-chart:batch:diff` を含み、`pie-chart/out/_baseline`
（ローカル生成物・git 管理外）と SVG を byte 比較する。clone 直後はこの基準が無く、
`batch:diff` は「基準が無い」ことを差分として扱い**必ず落ちる**（無ければ空として通す設計にすると、
基準の作り忘れが以後の退行を検出できない状態と区別できなくなる）。最初のフル `ci` の前に、
**コミット済みのクリーンな作業ツリー**で基準を 1 回作る:

```
pnpm run pie-chart:batch
pnpm --filter pie-chart run baseline:accept
```

以後、出力変更を意図した確定時だけ同じ 2 コマンドで基準を更新する。詳細と注意（未検証の変更を
基準に凍結しない）は `pie-chart/README.md` の「検証」節が正典。GitHub Actions では `out/_baseline`
を持てないため、この 2 段は GH の job に含めない（`scripts/ci-affected.test.mjs` の免除リスト）。
`pnpm run ci:affected`（pre-push）は pie-chart 領域に触れたときだけこの 2 段を走らせる。
```

- [ ] 表示を確認する(Markdown のレンダラは無いので、リンク切れ・コードフェンスの閉じ忘れを目視)

```
sed -n '/^### CI の分割と coverage ゲート/,/^## /p' README.md
```

  期待: 追加した小節が `### フル \`ci\` の前提` の見出しで表示され、コードフェンスが 2 本とも閉じている。

- [ ] コメント規約の機械検査(docs 原稿ではないが README も `.md` の走査対象)

```
pnpm run check:comments
```

  期待: エラー 0。

- [ ] コミット

```
git add README.md
git commit -m "docs(readme): clone 直後のフル ci には pie-chart の baseline を先に作る手順を書く

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---


---

### Task A7: `hostGuard.test.ts` の実 app 統合テストに実測へ合わせた timeout を付ける(設計 10.1)

**Files:**
- Modify: `editor/server/test/hostGuard.test.ts`(`describe('実 app.ts の Host 検査(buildApp の実配線)', ...)`
  91 行目付近)

**Interfaces:**
- Consumes: vitest の `describe(name, options, fn)`(`{ timeout }` は配下の `it` に継承される)。
  前例は `editor/server/test/projectInput.test.ts` 353〜355 行目(`it(..., { timeout: 60_000 }, ...)` +
  「ルート CI では既定 5s を超えて落ちる。遅いこと自体は退行ではないので上限を実測へ合わせる」)。
- Produces: 同ファイルの 4 つの `it`(いずれも `await import('../src/app.js')` で実 `buildApp()` を組む)に
  60 秒の上限。上の describe(再構築形 3 件。実 app を import しない)は既定 5 秒のまま。

- [ ] **Step 1: 実測を取る**

```powershell
pnpm exec vitest run --project server editor/server/test/hostGuard.test.ts --reporter=verbose
```

期待: 7 件 passed。verbose の各行末に ms が出る。実 app 側の 4 件のうち最初の 1 件(dynamic import の
初回)が最も長く、単独では 1 秒前後。この値を Step 2 のコメントの「単独なら」の根拠にする。

- [ ] **Step 2: describe に timeout を付ける**

```ts
// 実 `app.ts` の dynamic import は全ルート登録と web dist の探索を伴い、ルート CI
// (4 project 並列 + coverage) では既定 5s を超えて落ちることがある (単独なら 1s 前後)。
// 遅いこと自体は退行ではないので、上限は `projectInput.test.ts` と同じく実測へ合わせる。
describe('実 app.ts の Host 検査(buildApp の実配線)', { timeout: 60_000 }, () => {
  it('loopback 名は実ルートへ通り、攻撃者ドメインは本文ゼロの 403 になる', async () => {
```

describe 直前の既存コメント(「実配線(`buildApp()`)への統合テスト」の段落)はそのまま残し、その末尾に上の
3 行を続ける。

- [ ] **Step 3: 整形・検証・コミット**

```powershell
pnpm exec biome check --write editor/server/test/hostGuard.test.ts
pnpm exec vitest run --project server editor/server/test/hostGuard.test.ts
pnpm run check:comments
git add editor/server/test/hostGuard.test.ts
git commit -m "test(editor): hostGuard の実 app 統合テストに並走負荷の実測へ合わせた timeout を付ける

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

`editor/**` の変更なので、コミット前の `biome check --write` を飛ばさない(lint-staged のステージ入れ替わり
事故の回避)。

---

#### A3〜A8 共通の受入コマンド(pie-chart を触るタスクは毎回)

```powershell
# (1) SVG バイト不変。pie-chart ディレクトリで実行(README 検証節の正典コマンド)
cd C:\Users\caads\workspace\pie-chart
npm run batch
npm run batch:diff
# 期待: 末尾に `[batch:diff] OK — 全 83 件が baseline と byte 一致`、exit 0
cd C:\Users\caads\workspace

# (2) 3 つのゴールデン(render_hash 定数表 / final_score .snap / mark_flags .snap)
pnpm exec vitest run --project pie-chart test/render_hash test/final_score test/mark_flags
# 期待: Test Files 4 passed、Tests 全 passed、出力に `Snapshots ... written` / `updated` の行が無い

# (3) pie-chart 全体(leader_invariants / emit_passes / geometry を含む)と型
pnpm exec vitest run --project pie-chart
pnpm run typecheck:pie-chart
```

`out/_baseline` が無い端末では (1) の前に、**コミット済みのクリーンな状態で** `npm run batch` →
`npm run baseline:accept` を 1 回だけ実行する(README 検証節)。変更を入れた後に accept すると
以後の byte-diff が退行を検出できなくなるので、順序を守る。

---

### Task A3: 熱源の呼出回数カウンタと計測スクリプト(設計 2.2 段 1)

**Files:**
- Modify: `pie-chart/src/types.ts`(`Placement` の直後 ≒ 318 行目に `PerfCounters` を追加、
  `PieLayoutConfig` の `nameCondenseSteps`(≒ 396 行目)の直後に `perfCounters?` を追加)
- Modify: `pie-chart/src/layout/geometry.ts`(`placementBox` 777〜780 行目)
- Modify: `pie-chart/src/svg_export/leader_geometry.ts`(`realLeaderPaths` 793〜803 行目)
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(`measureRepairVec` 1554〜1570 行目、
  `tryBendGridOn` 1753〜1787 行目)
- Create: `pie-chart/scripts/profile_synthetic.ts`(`scripts/gen_glyph_advance.ts` と同じ tsx 直実行の慣習)
- Modify: `pie-chart/package.json`(`scripts` に `profile:synthetic`)

**Interfaces:**
- Consumes: `createPieLayoutConfig(overrides)`(`config.ts` 99 行目。`base = { ..., ...overrides }` なので
  `overrides.perfCounters` はそのまま cfg に乗り、`assertConfigValues` は触らない)。
  `renderPdfStylePieToSvg(items, options: Partial<PieLayoutConfig>)`(`pipeline.ts` 1182 行目)。
- Produces: `PerfCounters` 型と `cfg.perfCounters?`。計測点 4 箇所は `if (cfg.perfCounters)` の 1 分岐。
  `{ ...cfg, textColor }`(`pipeline.ts` 1559 行目)のような浅いコピーも同じカウンタオブジェクトを共有する。
- 出力への影響: 無し(カウンタは読み取り関数の呼出数で SVG 文字列に関与しない)。

- [ ] **Step 1: 型を足す**

`pie-chart/src/types.ts` の `Placement` インターフェース閉じ括弧の直後(`PieLayoutConfig` の JSDoc の前):

```ts
/**
 * 配置計算の熱源の呼出回数。`PieLayoutConfig.perfCounters` に渡すと各関数が加算する。
 * どれも純粋な読み取り関数の呼出数で、SVG 出力には関与しない。
 */
export interface PerfCounters {
  placementBox: number;
  realLeaderPaths: number;
  measureRepairVec: number;
  tryBendGridOn: number;
}
```

`PieLayoutConfig` の `nameCondenseSteps: number[];` の直後:

```ts
  /** 名前(長体)圧縮の試行段。大きい順に試し「収まる最大」を採る。例 [0.7, 0.6]。 */
  nameCondenseSteps: number[];
  /**
   * 開発時の計測フック (既定は未指定 = 計測しない)。`renderPdfStylePieToSvg(items, { perfCounters })`
   * からだけ渡す。`placementBox` は約 100 箇所から呼ばれ、到達できる引数が `cfg` だけなので
   * cfg の任意フィールドとして運ぶ。`{ ...cfg, textColor }` のような浅いコピーも同じオブジェクトを
   * 共有するため、コピー越しの呼出も同じカウンタへ入る。各計測点の分岐は `if (cfg.perfCounters)` 1 つ。
   */
  perfCounters?: PerfCounters;
```

- [ ] **Step 2: 計測点 4 箇所に 1 行ずつ足す**

`pie-chart/src/layout/geometry.ts`:

```ts
export function placementBox(placement: Placement, cfg: PieLayoutConfig): BBox {
  if (cfg.perfCounters) cfg.perfCounters.placementBox += 1;
  const measured = placementExtent(placement, cfg);
  return textBoxBounds(placement.x, placement.y, measured, placement.anchor, placement.baseline);
}
```

`pie-chart/src/svg_export/leader_geometry.ts`:

```ts
export function realLeaderPaths(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): (Pt[] | null)[] {
  if (cfg.perfCounters) cfg.perfCounters.realLeaderPaths += 1;
  return placements.map((p) => {
    const r = computeDrawnLeader(p, cfg, false);
    if (r.skipLeader) return null;
    return r.pathPoints.map((pt) => ({ x: coord.xScale(pt.x), y: coord.yScale(pt.y) }));
  });
}
```

`pie-chart/src/svg_export/emit_repair.ts`:

```ts
/** `RepairVec` の全フィールドを現在の placements から測る (純粋読み取り)。 */
export function measureRepairVec(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): RepairVec {
  if (cfg.perfCounters) cfg.perfCounters.measureRepairVec += 1;
  return {
    cross: countLeaderCrossings(placements, cfg, coord),
```

```ts
function tryBendGridOn(ctx: ResidualRepairCtx, p: Placement): boolean {
  const { cfg, pxUnit, vecOf, better } = ctx;
  if (cfg.perfCounters) cfg.perfCounters.tryBendGridOn += 1;
  const drawn2 = computeDrawnLeader(p, cfg, false);
```

- [ ] **Step 3: 計測スクリプトを置く**

`pie-chart/scripts/profile_synthetic.ts` を新規作成する(`.ps1` ではないので `.bat` 併設の対象外。
`scripts/gen_glyph_advance.ts` と同じく `tsx` で直実行):

```ts
// =============================================================================
// profile_synthetic.ts — 合成入力 1 ケースの描画時間と熱源の呼出回数を出す (開発時の計測)
// -----------------------------------------------------------------------------
// 配置計算の高速化は SVG バイト不変が鉄則で、効いたかどうかは出力からは分からない。ここで
// `perfCounters` (`types.ts`) の回数と壁時計を JSON 1 行で出し、変更前後を比べる。
//   実行: npm run profile:synthetic [ケース名]   (既定 gen_long_12_other)
// ケースは `test/helpers/syntheticCases.ts` の生成器から取る (render_hash 系テストと同一入力)。
// =============================================================================

import { performance } from 'node:perf_hooks';

import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';
import type { PerfCounters } from '../src/types.js';
import { syntheticCases } from '../test/helpers/syntheticCases.js';

const name = process.argv[2] ?? 'gen_long_12_other';
const items = syntheticCases()[name];
if (!items) {
  console.error(`[profile] 未知のケース名: ${name}`);
  process.exit(1);
}
const perfCounters: PerfCounters = {
  placementBox: 0,
  realLeaderPaths: 0,
  measureRepairVec: 0,
  tryBendGridOn: 0,
};
const t0 = performance.now();
const { svg } = await renderPdfStylePieToSvg(items, { perfCounters });
const seconds = Number(((performance.now() - t0) / 1000).toFixed(2));
console.log(JSON.stringify({ name, seconds, svgBytes: Buffer.byteLength(svg), ...perfCounters }));
```

`pie-chart/package.json` の `scripts`(`gen:widths` の直後):

```json
    "gen:widths": "tsx scripts/gen_glyph_advance.ts",
    "profile:synthetic": "tsx scripts/profile_synthetic.ts",
    "build:exe": "node scripts/build-exe.mjs"
```

- [ ] **Step 4: 基準値を取る**

```powershell
cd C:\Users\caads\workspace\pie-chart
npm run profile:synthetic
npm run profile:synthetic -- gen_short_12_other
cd C:\Users\caads\workspace
```

期待: JSON 1 行ずつ。例の形:
`{"name":"gen_long_12_other","seconds":6x.xx,"svgBytes":NNNNN,"placementBox":NNNNNNN,"realLeaderPaths":NNNNN,"measureRepairVec":NNNN,"tryBendGridOn":NNN}`。
`seconds` は設計 0 章の実測(約 65 秒)と同じ桁になる。4 つの数値を A4〜A6 の比較用に控える
(コミットメッセージ本文に「変更前」として残す)。

- [ ] **Step 5: バイト不変とゴールデン、型を確認してコミット**

本節共通の受入コマンド (1)(2)(3)。`batch:diff` は `[batch:diff] OK — 全 83 件が baseline と byte 一致`。
`typecheck:pie-chart` は `scripts/` を include しないので、スクリプト自体は Step 4 の実行で型が通ることを
確認したことにする。

```powershell
pnpm exec biome format --write pie-chart/src/types.ts pie-chart/src/layout/geometry.ts pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts pie-chart/scripts/profile_synthetic.ts
pnpm run check:ci
pnpm run check:comments
git add pie-chart/src/types.ts pie-chart/src/layout/geometry.ts pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts pie-chart/scripts/profile_synthetic.ts pie-chart/package.json
git commit -m "chore(pie-chart): 配置計算の熱源に呼出回数カウンタと合成入力の計測スクリプトを足す

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---

### Task A4: `measureRepairVec` で leader 幾何と box を 1 回だけ計算して配る(設計 2.2 段 2)

**Files:**
- Modify: `pie-chart/src/svg_export/leader_geometry.ts`(766〜1090 行目: `Coord` 型の後にまとめて
  `LeaderGeometry` / `collectLeaderGeometry` / `projectBoxToPixels` を追加し、`leaderCrossingPairs`
  812〜831 / `leaderThroughPairs` 847〜866 / `boxOverlapMax` 947〜959 / `boxPieIntrusionMax` 962〜972 /
  `boxViewOverflowOf` 975〜982 / `boxViewOverflowMax` 985〜993 / `projectBoxesToPixels` 996〜1010 /
  `oobLeaderCount` 1013〜1030 / `angularStacks` 1033〜1066 / `countAngularDiscordantPairs` 1074〜1090 を
  「配列を受け取る内部関数 + 既存 export の薄いラッパ」へ分ける)
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(import 44〜62 行目、`leaderPieCrossCount` 1647〜1666
  行目、`measureRepairVec` 1554〜1570 行目)

**Interfaces:**
- Consumes: `realLeaderPaths` / `placementBox` / `leaderCrossesBox` / `pathsCross` /
  `distPointToSegment`(いずれも純関数)。
- Produces: `LeaderGeometry { paths, boxes, pixelBoxes }`、`collectLeaderGeometry`、
  `countLeaderCrossingsFrom` / `countLeaderThroughLabelsFrom` / `countAngularDiscordantPairsFrom` /
  `boxOverlapMaxOf` / `boxPieIntrusionMaxOf` / `boxViewOverflowOfBox` / `boxViewOverflowMaxOf` /
  `oobLeaderCountFrom`(export)、`measureRepairVecFrom`(export。A6 が使う)。
- 既存 export(`countLeaderCrossings` / `leaderCrossingPairs` / `leaderThroughPairs` /
  `countLeaderThroughLabels` / `boxOverlapMax` / `boxPieIntrusionMax` / `boxViewOverflowOf` /
  `boxViewOverflowMax` / `projectBoxesToPixels` / `oobLeaderCount` / `countAngularDiscordantPairs` /
  `measureRepairVec`)の**シグネチャと戻り値は不変**。`mode_passes.ts` 1852 行目や `emit_repair.ts` の
  他の呼出はそのまま。
- 出力への影響: 無し。各値は同じ純関数を同じ引数で評価した結果で、`measureRepairVec` のフィールドは
  互いに独立な読み取りなので評価順の入れ替えは値に影響しない。
- 触らないもの(設計 2.3): `iterateOverlapPairs`(`post_layout.ts` 211〜240 行目。反復中に placement を
  動かすので box を冒頭で固定できない)、`EMIT_REPAIR_PASSES` の順序・stage。

- [ ] **Step 1: `leader_geometry.ts` に共有幾何を足す**

`Coord` 型(766〜771 行目)の直後、`pathsCross` の前に置く:

```ts
/** placement box の pixel 射影。`Coord` で y が反転しうるので min/max で辺を確定する。 */
export type PixelBox = { left: number; right: number; top: number; bottom: number };

/**
 * 1 回の採点で共有する leader 幾何。`measureRepairVec` が呼ぶ計数関数はどれも
 * `realLeaderPaths` (内部で `computeDrawnLeader` → `placementBox`) と `placementBox` を自前で
 * 作れるが、各関数に個別に作らせると採点 1 回につき同じ折れ線と box を 4 回以上作ることになる。
 * ここで placements 1 巡ぶんだけ計算し、`...From` / `...Of` 系の内部関数へ配る。
 * 値はどれも純関数の結果なので、1 回計算して配っても各関数が個別に計算しても同じ数値になる
 * (計算式と FP 演算の順序は各関数の中で不変)。
 */
export interface LeaderGeometry {
  /** 実描画 leader の pixel 折れ線 (skip は null)。`realLeaderPaths` と同じ。 */
  paths: (Pt[] | null)[];
  /** 各 placement の logical box。`placementBox` と同じ。 */
  boxes: BBox[];
  /** `boxes` の pixel 射影。`projectBoxesToPixels` と同じ。 */
  pixelBoxes: PixelBox[];
}

export function collectLeaderGeometry(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): LeaderGeometry {
  const paths = realLeaderPaths(placements, cfg, coord);
  const boxes = placements.map((p) => placementBox(p, cfg));
  return { paths, boxes, pixelBoxes: boxes.map((lb) => projectBoxToPixels(lb, coord)) };
}

function projectBoxToPixels(lb: BBox, coord: Coord): PixelBox {
  return {
    left: Math.min(coord.xScale(lb.left), coord.xScale(lb.right)),
    right: Math.max(coord.xScale(lb.left), coord.xScale(lb.right)),
    top: Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom)),
    bottom: Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom)),
  };
}
```

- [ ] **Step 2: 交差・貫通の対集合を「配列を受け取る内部関数 + ラッパ」に分ける**

`leaderCrossingPairs`(812〜831 行目)と `countLeaderCrossings`(833〜839 行目)を次にする(JSDoc は現行のまま):

```ts
function crossingPairsFrom(placements: Placement[], paths: (Pt[] | null)[]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < paths.length; i += 1) {
    const pa = paths[i];
    if (!pa) continue;
    for (let j = i + 1; j < paths.length; j += 1) {
      const pb = paths[j];
      if (!pb || !pathsCross(pa, pb)) continue;
      const [x, y] = [placements[i].item.name, placements[j].item.name].sort();
      pairs.add(`${x}×${y}`);
    }
  }
  return pairs;
}

export function leaderCrossingPairs(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): Set<string> {
  return crossingPairsFrom(placements, realLeaderPaths(placements, cfg, coord));
}

/** 実描画 leader 同士が交差する対の数 (verify の "leader crossing" と同条件・pixel 空間)。 */
export function countLeaderCrossings(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return leaderCrossingPairs(placements, cfg, coord).size;
}

/** `countLeaderCrossings` の事前計算版 (`collectLeaderGeometry` の結果から数える)。 */
export function countLeaderCrossingsFrom(placements: Placement[], geo: LeaderGeometry): number {
  return crossingPairsFrom(placements, geo.paths).size;
}
```

`leaderThroughPairs`(847〜866 行目)と `countLeaderThroughLabels`(868〜874 行目):

```ts
function throughPairsFrom(
  placements: Placement[],
  paths: (Pt[] | null)[],
  pixelBoxes: PixelBox[],
): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < paths.length; i += 1) {
    const pts = paths[i];
    if (!pts) continue;
    for (let j = 0; j < placements.length; j += 1) {
      if (j === i) continue;
      if (leaderCrossesBox(pts, pixelBoxes[j]))
        pairs.add(`${placements[i].item.name}>${placements[j].item.name}`);
    }
  }
  return pairs;
}

export function leaderThroughPairs(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): Set<string> {
  const paths = realLeaderPaths(placements, cfg, coord);
  const boxes = projectBoxesToPixels(placements, cfg, coord);
  return throughPairsFrom(placements, paths, boxes);
}

/** 実描画 leader が自分以外のラベル box を貫く件数 (verify の "leader through label" と同条件・pixel)。 */
export function countLeaderThroughLabels(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return leaderThroughPairs(placements, cfg, coord).size;
}

/** `countLeaderThroughLabels` の事前計算版。 */
export function countLeaderThroughLabelsFrom(placements: Placement[], geo: LeaderGeometry): number {
  return throughPairsFrom(placements, geo.paths, geo.pixelBoxes).size;
}
```

- [ ] **Step 3: box 系の計測を box 配列版に分ける**

`boxOverlapMax`(947〜959 行目)。内側ループの `placementBox(placements[j], cfg)` が O(n²) 回の再計算源
(設計 2.1 の熱源 2):

```ts
/** 全 placement 対の最大縦重なり量 (logical, X が重なる対のみ)。do-no-harm の ovl 指標。 */
export function boxOverlapMax(placements: Placement[], cfg: PieLayoutConfig): number {
  return boxOverlapMaxOf(placements.map((p) => placementBox(p, cfg)));
}

/** `boxOverlapMax` の box 配列版。対ごとに `placementBox` を作り直さない。 */
export function boxOverlapMaxOf(boxes: BBox[]): number {
  let m = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
      if (ox > 0 && oy > 0) m = Math.max(m, oy);
    }
  }
  return m;
}
```

`boxPieIntrusionMax`(962〜972 行目):

```ts
export function boxPieIntrusionMax(placements: Placement[], cfg: PieLayoutConfig): number {
  return boxPieIntrusionMaxOf(
    placements,
    placements.map((p) => placementBox(p, cfg)),
    cfg,
  );
}

/** `boxPieIntrusionMax` の box 配列版 (`boxes[i]` は `placements[i]` の box)。 */
export function boxPieIntrusionMaxOf(
  placements: Placement[],
  boxes: BBox[],
  cfg: PieLayoutConfig,
): number {
  let m = 0;
  for (let i = 0; i < placements.length; i += 1) {
    if (placements[i].insideSlice) continue;
    const bx = boxes[i];
    const nx = Math.max(bx.left, Math.min(bx.right, 0));
    const ny = Math.max(bx.bottom, Math.min(bx.top, 0));
    m = Math.max(m, cfg.pieRadius - Math.hypot(nx, ny));
  }
  return m;
}
```

`boxViewOverflowOf` / `boxViewOverflowMax` / `projectBoxesToPixels`(975〜1010 行目):

```ts
/** 1 つの placement box の viewBox はみ出し量 (pixel, 4 辺の最大。負=内側はそのまま負値)。 */
export function boxViewOverflowOf(p: Placement, cfg: PieLayoutConfig, coord: Coord): number {
  return boxViewOverflowOfBox(placementBox(p, cfg), coord);
}

/** `boxViewOverflowOf` の box 版。 */
export function boxViewOverflowOfBox(lb: BBox, coord: Coord): number {
  const left = Math.min(coord.xScale(lb.left), coord.xScale(lb.right));
  const right = Math.max(coord.xScale(lb.left), coord.xScale(lb.right));
  const top = Math.min(coord.yScale(lb.top), coord.yScale(lb.bottom));
  const bottom = Math.max(coord.yScale(lb.top), coord.yScale(lb.bottom));
  return Math.max(-left, right - coord.width, -top, bottom - coord.height);
}

/** 全 placement box の viewBox はみ出し量の最大 (pixel, 0 下限)。 */
export function boxViewOverflowMax(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return boxViewOverflowMaxOf(
    placements.map((p) => placementBox(p, cfg)),
    coord,
  );
}

/** `boxViewOverflowMax` の box 配列版。 */
export function boxViewOverflowMaxOf(boxes: BBox[], coord: Coord): number {
  let m = 0;
  for (const lb of boxes) m = Math.max(m, boxViewOverflowOfBox(lb, coord));
  return Math.max(0, m);
}

/** placement box を pixel 空間の {left,right,top,bottom} へ射影した配列 (leader×box 貫通判定の前処理)。 */
export function projectBoxesToPixels(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): PixelBox[] {
  return placements.map((p) => projectBoxToPixels(placementBox(p, cfg), coord));
}
```

`oobLeaderCount`(1013〜1030 行目):

```ts
/** いずれかの点が viewBox を 1px 超はみ出す leader の本数 (do-no-harm の oob 指標)。 */
export function oobLeaderCount(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return oobLeaderCountFrom(realLeaderPaths(placements, cfg, coord), coord);
}

/** `oobLeaderCount` の path 配列版。 */
export function oobLeaderCountFrom(paths: (Pt[] | null)[], coord: Coord): number {
  let c = 0;
  for (const pts of paths) {
    if (!pts) continue;
    for (const q of pts) {
      if (q.x < -1 || q.x > coord.width + 1 || q.y < -1 || q.y > coord.height + 1) {
        c += 1;
        break;
      }
    }
  }
  return c;
}
```

- [ ] **Step 4: 角度順の discordant 対を配列版に分ける**

`angularStacks`(1033〜1066 行目)と `countAngularDiscordantPairs`(1074〜1090 行目)。JSDoc・本文中の
コメントは現行のまま残し、`paths` と `boxes` だけ引数から受ける:

```ts
type AngularStack = { labelY: number; anchorY: number }[];

function angularStacksFrom(
  placements: Placement[],
  coord: Coord,
  paths: (Pt[] | null)[],
  boxes: BBox[],
): { left: AngularStack; right: AngularStack } {
  const cx = coord.xScale(0);
  const cy = coord.yScale(0);
  const left: AngularStack = [];
  const right: AngularStack = [];
  placements.forEach((p, i) => {
    if (p.insideSlice) return;
    // (現行の「その他」除外コメントをそのまま残す)
    if (isOtherCategory(p.item.name) && (topBandSonohokaZone(p.item) !== null || p.forceTopRight)) {
      return;
    }
    const pts = paths[i];
    if (!pts || pts.length < 2) return;
    const head = pts[0];
    const tail = pts[pts.length - 1];
    const anchor =
      Math.hypot(head.x - cx, head.y - cy) <= Math.hypot(tail.x - cx, tail.y - cy) ? head : tail;
    // (現行の「box 縦中心で測る」コメントをそのまま残す)
    const box = boxes[i];
    const entry = { labelY: coord.yScale((box.top + box.bottom) / 2), anchorY: anchor.y };
    (coord.xScale(p.x) < cx ? left : right).push(entry);
  });
  return { left, right };
}

/** verify と同基準で各円外ラベルの {labelY, anchorY} (pixel) を左右スタックに分けて返す。 */
function angularStacks(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): { left: AngularStack; right: AngularStack } {
  return angularStacksFrom(
    placements,
    coord,
    realLeaderPaths(placements, cfg, coord),
    placements.map((p) => placementBox(p, cfg)),
  );
}

function discordantPairsOf(stacks: { left: AngularStack; right: AngularStack }): number {
  let dis = 0;
  for (const arr of [stacks.left, stacks.right]) {
    arr.sort((a, b) => a.labelY - b.labelY);
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        if (arr[j].anchorY < arr[i].anchorY - 2) dis += 1;
      }
    }
  }
  return dis;
}

export function countAngularDiscordantPairs(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  return discordantPairsOf(angularStacks(placements, cfg, coord));
}

/** `countAngularDiscordantPairs` の事前計算版。 */
export function countAngularDiscordantPairsFrom(
  placements: Placement[],
  coord: Coord,
  geo: LeaderGeometry,
): number {
  return discordantPairsOf(angularStacksFrom(placements, coord, geo.paths, geo.boxes));
}
```

現行の `angularStacks` は除外対象を飛ばしてから `placementBox` を呼ぶが、配列版は全 placement の box を
先に持つ。余計に作る box は値に関与しない(その index を読まないだけ)。

- [ ] **Step 5: `emit_repair.ts` の `leaderPieCrossCount` と `measureRepairVec` を書き換える**

import(44〜62 行目の `./leader_geometry.js` から)に追加する:

```ts
import {
  ALWAYS_DRAW_OUTSIDE_LEADERS,
  computeDrawnLeader,
  resolveLeaderCrossings,
  distPointToSegment,
  pathsCross,
  realLeaderPaths,
  countLeaderCrossings,
  countLeaderThroughLabels,
  leaderThroughPairs,
  leaderCrossingPairs,
  countBundledRimStubs,
  boxOverlapMax,
  boxPieIntrusionMax,
  boxViewOverflowOf,
  boxViewOverflowMax,
  projectBoxesToPixels,
  oobLeaderCount,
  countAngularDiscordantPairs,
  collectLeaderGeometry,
  countLeaderCrossingsFrom,
  countLeaderThroughLabelsFrom,
  countAngularDiscordantPairsFrom,
  boxOverlapMaxOf,
  boxPieIntrusionMaxOf,
  boxViewOverflowOfBox,
  boxViewOverflowMaxOf,
  oobLeaderCountFrom,
} from './leader_geometry.js';
import type { Pt, Coord, LeaderGeometry } from './leader_geometry.js';
```

`leaderPieCrossCount`(1647〜1666 行目):

```ts
/** leader path が pie 円に侵入している本数 (pieRPx-1 余裕)。 */
function leaderPieCrossCount(placements: Placement[], cfg: PieLayoutConfig, coord: Coord): number {
  return leaderPieCrossCountFrom(realLeaderPaths(placements, cfg, coord), cfg, coord);
}

function leaderPieCrossCountFrom(
  paths: (Pt[] | null)[],
  cfg: PieLayoutConfig,
  coord: Coord,
): number {
  const cx = coord.xScale(0);
  const cy = coord.yScale(0);
  const pieRPx = Math.abs(coord.xScale(cfg.pieRadius) - coord.xScale(0));
  let c = 0;
  for (const path of paths) {
    if (!path) continue;
    for (let k = 0; k + 1 < path.length; k += 1) {
      if (
        distPointToSegment(cx, cy, path[k].x, path[k].y, path[k + 1].x, path[k + 1].y) <
        pieRPx - 1
      ) {
        c += 1;
        break;
      }
    }
  }
  return c;
}
```

`measureRepairVec`(1554〜1570 行目):

```ts
/** `RepairVec` の全フィールドを現在の placements から測る (純粋読み取り)。 */
export function measureRepairVec(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): RepairVec {
  if (cfg.perfCounters) cfg.perfCounters.measureRepairVec += 1;
  return measureRepairVecFrom(placements, cfg, coord, collectLeaderGeometry(placements, cfg, coord));
}

/**
 * `measureRepairVec` の本体。leader 折れ線と box を `geo` から読むので、9 つの指標が同じ幾何を
 * 共有し、呼び出し側は候補ループで幾何を使い回せる (1 本の leader だけ動かすときに全体を
 * 作り直さない)。各指標は互いに独立な読み取りなので、幾何を先に作っても値は変わらない。
 */
export function measureRepairVecFrom(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  geo: LeaderGeometry,
): RepairVec {
  return {
    cross: countLeaderCrossingsFrom(placements, geo),
    pieCross: leaderPieCrossCountFrom(geo.paths, cfg, coord),
    through: countLeaderThroughLabelsFrom(placements, geo),
    inv: countAngularDiscordantPairsFrom(placements, coord, geo),
    clips: geo.boxes.filter((lb) => boxViewOverflowOfBox(lb, coord) > 1).length,
    oob: oobLeaderCountFrom(geo.paths, coord),
    ovl: boxOverlapMaxOf(geo.boxes),
    boxPie: boxPieIntrusionMaxOf(placements, geo.boxes, cfg),
    view: boxViewOverflowMaxOf(geo.boxes, coord),
  };
}
```

- [ ] **Step 6: 型・未使用 import を整理する**

```powershell
pnpm run typecheck:pie-chart
```

`noUnusedLocals` で `boxViewOverflowOf` / `oobLeaderCount` 等の既存 import が未使用になっていれば
(`measureRepairVec` 以外の呼出が残っているかは `grep -n 'boxViewOverflowOf(' pie-chart/src/svg_export/emit_repair.ts`
で確認)、その import だけ外す。export 自体は消さない(`mode_passes.ts` と `verify/` が使う)。

- [ ] **Step 7: バイト不変・ゴールデン・計測**

本節共通の受入コマンド (1)(2)(3) を実行し、すべて緑であることを確認する。続けて:

```powershell
cd C:\Users\caads\workspace\pie-chart
npm run profile:synthetic
cd C:\Users\caads\workspace
```

期待: A3 Step 4 の基準値に対して `placementBox` と `realLeaderPaths` が減り(`measureRepairVec` の
回数は不変)、`seconds` が縮む。`svgBytes` は不変。数値をコミットメッセージ本文へ「変更前 → 変更後」で残す。
`gen_long_12_other` が **5 秒以下**なら A5・A6 は不要(A8 へ)。5 秒を超えていれば A5 へ進む。

- [ ] **Step 8: コミット**

```powershell
pnpm exec biome format --write pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts
pnpm run check:ci
pnpm run check:comments
git add pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts
git commit -m "perf(pie-chart): 採点ベクトルの leader 折れ線と box を 1 回だけ計算して各計数へ配る

gen_long_12_other: <before>s → <after>s、placementBox <n0> → <n1>、realLeaderPaths <m0> → <m1>。
SVG 出力は batch:diff で全 83 件 byte 一致、render_hash / final_score / mark_flags 不変。

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---

### Task A5(条件付き: A4 後も `gen_long_12_other` > 5 秒のとき): `placementExtent` の placement 単位メモ(設計 2.2 段 3)

**Files:**
- Modify: `pie-chart/src/layout/geometry.ts`(`placementExtent` 758〜775 行目を `computePlacementExtent` に
  改名し、メモ付きの `placementExtent` を前置。`Placement` / `LayoutItem` 型は 8 行目で import 済み)

**Interfaces:**
- Consumes: `Placement.lines` / `nameScaleX` / `nameSplit` / `item`(設計 2.2 の確認事項: これらは配置パスで
  **代入置換のみ**で in-place 変更が無く、`item.name` / `percentText` への代入は 0 件)。`placementExtent` が
  読む cfg フィールド(`fontWeight` / `visualFullwidthEm` / `visualHalfwidthEm` / `fontSizeMm` /
  `charWidthFactor` / `textRenderScale` / `mmPerUnit` / `lineHeightFactor`)は描画中に変異しない
  (`pieLabelClearance` は読まない)。
- Produces: `placementExtent(placement, cfg): Extent`(シグネチャ・戻り値とも不変。毎回新しいオブジェクトを返す)。
- 制約(設計 2.3): モジュールグローバルのメモは**これ以外に**新設しない。`WeakMap` のエントリは placement と
  共に回収され、寿命は 1 回の描画に閉じる。cfg の参照一致も要求するので、`{ ...cfg, textColor }` の
  ような浅いコピー越しの呼出はメモを外して再計算する(取り違えが起きない)。
- 出力への影響: 無し(純関数のメモ)。

- [ ] **Step 1: メモ付き `placementExtent` にする**

```ts
/**
 * `placementExtent` の placement 単位メモ。extent は (`lines`, `nameScaleX`, `nameSplit`, `item`,
 * cfg の文字寸法フィールド) の純関数で、配置パスはこれらを代入で置き換えるだけで in-place 変更を
 * しない (`seamSnapshot` が前提にしている規約と同じ)。よって参照一致で再利用できる。
 * エントリは placement と共に消えるので寿命は 1 回の描画に閉じ、cfg も参照一致を要求するので
 * 別 cfg (浅いコピーを含む) との取り違えは起きない。返す値は毎回コピーにし、呼び出し側の
 * 書き換えがメモへ漏れないようにする。
 */
interface ExtentMemo {
  cfg: PieLayoutConfig;
  lines: string[];
  nameScaleX: number | undefined;
  nameSplit: boolean | undefined;
  item: LayoutItem;
  extent: Extent;
}
const EXTENT_MEMO = new WeakMap<Placement, ExtentMemo>();

/**
 * placement の実描画 extent (論理単位)。行数は placement.lines.length、名前長体は
 * placement.nameScaleX を反映する (% は原寸)。scaledLabelWidthUnits(...,1) は
 * 非圧縮 estimateVerifyTextExtent と一致するため、衝突/クランプの幅源を一本化できる。
 */
export function placementExtent(placement: Placement, cfg: PieLayoutConfig): Extent {
  const hit = EXTENT_MEMO.get(placement);
  if (
    hit &&
    hit.cfg === cfg &&
    hit.lines === placement.lines &&
    hit.nameScaleX === placement.nameScaleX &&
    hit.nameSplit === placement.nameSplit &&
    hit.item === placement.item
  ) {
    return { width: hit.extent.width, height: hit.extent.height };
  }
  const extent = computePlacementExtent(placement, cfg);
  EXTENT_MEMO.set(placement, {
    cfg,
    lines: placement.lines,
    nameScaleX: placement.nameScaleX,
    nameSplit: placement.nameSplit,
    item: placement.item,
    extent: { width: extent.width, height: extent.height },
  });
  return extent;
}

function computePlacementExtent(placement: Placement, cfg: PieLayoutConfig): Extent {
  const lineCount = placement.lines.length >= 2 ? 2 : 1;
  const sx = placement.nameScaleX ?? 1;
  if (placement.nameSplit && placement.lines.length >= 2) {
    // 名前分割ラベル: lines = [名前前半, 名前後半+%]。長体は上行 (名前前半) のみ。
    // scaledLabelWidthUnits(line1, line2, 2, sx) = max(em(line1)×sx, em(line2)) × unit。
    return {
      width: scaledLabelWidthUnits(placement.lines[0], placement.lines[1], 2, sx, cfg),
      height: labelHeightUnits(2, cfg),
    };
  }
  const name = placement.item.name;
  const percent = placement.item.percentText ?? '';
  return {
    width: scaledLabelWidthUnits(name, percent, lineCount, sx, cfg),
    height: labelHeightUnits(lineCount, cfg),
  };
}
```

現行 758 行目の直前にある重複した JSDoc(「placement の現在位置から `verify/svg.ts` と同じ bbox を計算する」)
は `placementBox` のものなので、`placementBox` の直前へ移す。

- [ ] **Step 2: in-place 変更が無いことを機械的に再確認する**

```powershell
Select-String -Path pie-chart/src/**/*.ts -Pattern '\.lines\.(push|splice|pop|shift|unshift|sort|reverse)\(|\.lines\[\d+\]\s*=|\.item\.(name|percentText)\s*='
```

期待: 該当なし(`lines.length === 1` のような読み取りだけ)。1 件でも出たら本タスクは実施せず、設計 2.2 の
「未達なら別計画」に従う。

- [ ] **Step 3: 受入とコミット**

本節共通の受入コマンド (1)(2)(3) + `npm run profile:synthetic`。`placementBox` の回数は A4 と同じ
(メモは `placementBox` の内側で効くので回数でなく `seconds` に出る)。`geometry.test.ts` の
`placementExtent / placementBox` が緑であることを (3) で確認する。

```powershell
pnpm exec biome format --write pie-chart/src/layout/geometry.ts
pnpm run check:ci
pnpm run check:comments
git add pie-chart/src/layout/geometry.ts
git commit -m "perf(pie-chart): placementExtent を placement 単位で参照一致メモにする

gen_long_12_other: <before>s → <after>s。SVG 出力は batch:diff で全 83 件 byte 一致、
render_hash / final_score / mark_flags 不変。

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

`gen_long_12_other` が 5 秒以下なら A8 へ。超えていれば A6 へ。

---

### Task A6(条件付き: A5 後も > 5 秒のとき): bend 格子の候補ループで幾何を持ち上げる(設計 2.2 段 4)

**Files:**
- Modify: `pie-chart/src/svg_export/leader_geometry.ts`(`collectLeaderGeometry` の直後に
  `replaceLeaderGeometryAt` を追加)
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(`ResidualVec` 1724〜1733 行目の直後に `toResidualVec`
  を追加、`tryBendGridOn` 1753〜1787 行目、`tryRebendInvolved` の格子ループ 1814〜1836 行目、
  `repairResidualLeaderDefects` の `vecOf` 2064〜2076 行目)

**Interfaces:**
- Consumes: A4 の `LeaderGeometry` / `collectLeaderGeometry` / `measureRepairVecFrom`。
- Produces: `replaceLeaderGeometryAt(geo, placements, cfg, coord, i)`(index `i` だけ現在の placement から
  作り直した新しい `LeaderGeometry`。元の `geo` は変更しない)、`toResidualVec(m: RepairVec): ResidualVec`。
- 前提: 格子の候補間で動くのは対象 placement の `leaderBend` と 2 つの follows フラグだけで、これらは
  その placement の leader 折れ線にしか影響しない(box は `x` / `y` / extent から決まり bend を読まない)。
  他の placement の折れ線と全 box は候補間で不変。
- 出力への影響: 無し。差し替える `paths[i]` / `boxes[i]` / `pixelBoxes[i]` は `collectLeaderGeometry`
  と同じ式で作るので、全体を作り直した場合と同じ数値になる。

- [ ] **Step 1: `replaceLeaderGeometryAt` を足す**

`leader_geometry.ts` の `collectLeaderGeometry` の直後:

```ts
/**
 * `geo` の index `i` だけを現在の placement から作り直した幾何 (元の `geo` は触らない)。
 * bend 格子の候補ループのように 1 本の leader しか動かない場面で、他の leader と全 box を
 * 作り直さないために使う。差し替える値は `collectLeaderGeometry` と同じ式で作るので、全体を
 * 作り直した場合と同じ数値になる。
 */
export function replaceLeaderGeometryAt(
  geo: LeaderGeometry,
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  i: number,
): LeaderGeometry {
  const r = computeDrawnLeader(placements[i], cfg, false);
  const path = r.skipLeader
    ? null
    : r.pathPoints.map((pt) => ({ x: coord.xScale(pt.x), y: coord.yScale(pt.y) }));
  const box = placementBox(placements[i], cfg);
  const paths = geo.paths.slice();
  const boxes = geo.boxes.slice();
  const pixelBoxes = geo.pixelBoxes.slice();
  paths[i] = path;
  boxes[i] = box;
  pixelBoxes[i] = projectBoxToPixels(box, coord);
  return { paths, boxes, pixelBoxes };
}
```

- [ ] **Step 2: `ResidualVec` への射影を関数にする**

`emit_repair.ts` の `ResidualVec` インターフェースの直後:

```ts
/** `RepairVec` → `ResidualVec` の射影 (crossPie = cross + pieCross)。 */
function toResidualVec(m: RepairVec): ResidualVec {
  return {
    crossPie: m.cross + m.pieCross,
    through: m.through,
    inv: m.inv,
    clips: m.clips,
    oob: m.oob,
    ovl: m.ovl,
    view: m.view,
    boxPie: m.boxPie,
  };
}
```

`repairResidualLeaderDefects` の `vecOf`(2064〜2076 行目)をこれに寄せる:

```ts
  const vecOf = (): ResidualVec => toResidualVec(measureRepairVec(placements, cfg, coord));
```

- [ ] **Step 3: `tryBendGridOn` の候補ループを持ち上げる**

```ts
// p の bend を格子から選び直し、cur より良くなる候補があれば適用したまま true を返す。
// 無ければ元の bend/フラグへ戻して false。 (単独手・複合手の両方から使う)
function tryBendGridOn(ctx: ResidualRepairCtx, p: Placement): boolean {
  const { placements, cfg, coord, pxUnit, vecOf, better } = ctx;
  if (cfg.perfCounters) cfg.perfCounters.tryBendGridOn += 1;
  const drawn2 = computeDrawnLeader(p, cfg, false);
  if (drawn2.skipLeader || drawn2.pathPoints.length < 2) return false;
  const a2 = drawn2.pathPoints[0];
  const e2 = drawn2.detectPathPoints[drawn2.detectPathPoints.length - 1];
  const tA = Math.atan2(a2.y, a2.x);
  const tE = Math.atan2(e2.y, e2.x);
  let dT = tE - tA;
  while (dT > Math.PI) dT -= 2 * Math.PI;
  while (dT < -Math.PI) dT += 2 * Math.PI;
  if (Math.abs(dT) < 0.05 || Math.abs(dT) > LEADER_MAX_ANGULAR_DIFF_RAD) return false;
  const sv = {
    bend: { ...p.leaderBend },
    fy: p.leaderBendFollowsEndpointY,
    fx: p.leaderBendFollowsEndpointX,
  };
  const cur2 = vecOf();
  // 格子の候補間で動くのは p の bend だけで、他の leader と全 box は候補間で不変。幾何を 1 回だけ
  // 集め、候補ごとに p の分だけ差し替えて測る (全体を作り直すのと同じ数値になる)。
  const base = collectLeaderGeometry(placements, cfg, coord);
  const i = placements.indexOf(p);
  const measure =
    i >= 0
      ? (): ResidualVec =>
          toResidualVec(
            measureRepairVecFrom(
              placements,
              cfg,
              coord,
              replaceLeaderGeometryAt(base, placements, cfg, coord, i),
            ),
          )
      : vecOf;
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    for (const rPx of [2.5, 5, 9, 14, 22, 34]) {
      const th = tA + dT * f;
      const rr = cfg.pieRadius + rPx * pxUnit;
      p.leaderBend = { x: rr * Math.cos(th), y: rr * Math.sin(th) };
      p.leaderBendFollowsEndpointY = false;
      p.leaderBendFollowsEndpointX = false;
      if (better(measure(), cur2)) return true;
    }
  }
  p.leaderBend = sv.bend;
  p.leaderBendFollowsEndpointY = sv.fy;
  p.leaderBendFollowsEndpointX = sv.fx;
  return false;
}
```

`i < 0`(p が placements に無い)のときは従来どおり全体を測る `vecOf` に倒す。この分岐は挙動を
変えないための保険で、現行の呼出はすべて `placements` の要素を渡している。

- [ ] **Step 4: `tryRebendInvolved` の同形の格子ループも持ち上げる**

1814〜1836 行目(`outer:` ラベル付きループ)。ここは `i` がループ変数として既にある:

```ts
    const save = {
      bend: { ...p.leaderBend },
      fy: p.leaderBendFollowsEndpointY,
      fx: p.leaderBendFollowsEndpointX,
    };
    // `tryBendGridOn` と同じ理由で、格子の候補間で不変な他の leader と全 box は 1 回だけ集める。
    const base = bendFeasible ? collectLeaderGeometry(placements, cfg, coord) : null;
    outer: for (const f of bendFeasible ? [0.5, 0.35, 0.65, 0.2, 0.8] : []) {
      for (const rPx of [2.5, 5, 9, 14, 22, 34]) {
        const th = thA + dTh * f;
        const rr = cfg.pieRadius + rPx * pxUnit;
        p.leaderBend = { x: rr * Math.cos(th), y: rr * Math.sin(th) };
        p.leaderBendFollowsEndpointY = false;
        p.leaderBendFollowsEndpointX = false;
        const v = base
          ? toResidualVec(
              measureRepairVecFrom(
                placements,
                cfg,
                coord,
                replaceLeaderGeometryAt(base, placements, cfg, coord, i),
              ),
            )
          : vecOf();
        if (better(v, cur)) {
```

以降(`ADOPT` のデバッグログ・`adopted = true; break outer;`・復元)は現行のまま。

- [ ] **Step 5: import を足して型を通す**

`emit_repair.ts` の `./leader_geometry.js` import に `replaceLeaderGeometryAt` を追加し、
`pnpm run typecheck:pie-chart`。

- [ ] **Step 6: 受入とコミット**

本節共通の受入コマンド (1)(2)(3)。`test/emit_passes.test.ts`(パス順序)と `test/leader_invariants.test.ts`
が緑であること。`npm run profile:synthetic` で `realLeaderPaths` と `placementBox` がさらに減り、
`tryBendGridOn` / `measureRepairVec` の回数は A4 と同じ(候補数は変えていない = 早期打ち切りをしていない)。

```powershell
pnpm exec biome format --write pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts
pnpm run check:ci
pnpm run check:comments
git add pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts
git commit -m "perf(pie-chart): bend 格子の候補ループで動かない leader と box を持ち上げ、対象 1 本だけ測り直す

gen_long_12_other: <before>s → <after>s、realLeaderPaths <m0> → <m1>。tryBendGridOn の回数は不変。
SVG 出力は batch:diff で全 83 件 byte 一致、render_hash / final_score / mark_flags 不変。

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

それでも 5 秒を超える場合は、ここで pie-chart 高速化を止め、設計 2.2 の「出力の変更を伴う案は本計画では
扱わず別計画に起こす」に従う(A8 は実施しない。`render_hash_long` は 300 秒のまま)。

---

### Task A8(条件付き・最終: A4〜A6 のどこかで `gen_long_12_other` ≤ 5 秒に達したとき): `render_hash_long` の timeout を 60 秒へ縮める

**Files:**
- Modify: `pie-chart/test/render_hash_long.test.ts`(`it.each` の `{ timeout: 300_000 }` とその直前のコメント)

**Interfaces:**
- Consumes: A2 の `render_hash_long.test.ts`。
- Produces: ケース単位 60 秒(`render_hash.test.ts` と同じ値)。

- [ ] **Step 1: 実測を確認する**

```powershell
pnpm exec vitest run --project pie-chart test/render_hash_long --reporter=verbose
```

期待: 2 件 passed、各 5 秒以下(単独)。併走時は 2〜3 倍に伸びる前提でも 60 秒に収まる。

- [ ] **Step 2: 値とコメントを変える**

```ts
describe('合成入力の SVG ハッシュ固定 (配置計算が重いケース)', () => {
  // timeout はルート `vitest run --coverage` (4 project 並列) 併走時の実測を余裕込みで収める値
  // (`render_hash.test.ts` と同じ判断・同じ値)。
  it.each(LONG_CASES)(
    '%s の SHA256 が定数表と一致する',
    { timeout: 60_000 },
    async (name, items) => {
```

- [ ] **Step 3: 24 + 2 ケースの単独時間が受入(`render_hash.test.ts` 30 秒以下)に収まることを確認してコミット**

```powershell
pnpm exec vitest run --project pie-chart test/render_hash
```

期待: `Test Files 2 passed`、`Tests 27 passed`、`Duration` が 30 秒台以下。

```powershell
git add pie-chart/test/render_hash_long.test.ts
git commit -m "test(pie-chart): render_hash_long の timeout を高速化後の実測へ縮める

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```

---

### Task A9: 最終検証 — cold の `pnpm run ci` を測り、設計の 0 章と 10 章を確定する

**Files:**
- Modify: `docs/superpowers/specs/2026-09-06-ci-optimization-design.md`(0 章の表、10 章の完了条件)

**Interfaces:**
- Consumes: A1 の基準値(変更前の cold 壁時計)、A2〜A8・P1〜P2・C1〜C6 のすべてのコミット。
- Produces: 計画 A の完了判定(10 分未満 / `batch:diff` 一致 / ゴールデン不変 / `ci-affected.test.mjs` 緑)。

- [ ] **Step 1: 並走負荷が無いことを確認する**

```powershell
netstat -ano | findstr ":2468"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
```

期待: 24680 / 24681 の LISTENING が無い。vitest / playwright / vite のプロセスが無い(別チェックアウトの
`tsx watch` は対象外)。残っていれば `Stop-Process -Id <pid> -Force` で止めてから進む。

- [ ] **Step 2: cold の `pnpm run ci` を 1 本通して壁時計を取る**

```powershell
$s = Get-Date; pnpm run ci *> ci-final.log; $r = $LASTEXITCODE; "exit=$r elapsed=$((Get-Date) - $s)"
```

期待: `exit=0`、elapsed が 10 分未満。`ci-final.log` に `Test Files … passed`、`batch:diff` の一致
(`all N files match` 相当の行)、`33 passed` の e2e 要約が並ぶ。ログはコミットしない(削除する)。

- [ ] **Step 3: 受入条件を個別に確認する**

```powershell
cd pie-chart; npm run batch; npm run batch:diff; cd ..
pnpm exec vitest run --project pie-chart test/render_hash test/final_score test/mark_flags
pnpm run test:scripts
```

期待: `batch:diff` 一致、3 ゴールデン緑、`test:scripts` 緑。`render_hash_long.test.ts` の
`gen_long_12_other` の所要が 5 秒以下なら A8 が入っていること(timeout 60 秒)。5 秒超なら
A5 / A6 が未達のまま閉じた旨を 10 章に書く。

- [ ] **Step 4: 設計の 0 章の表に「フル ci(cold、計画 A 後)」の行を足し、10 章の計画 A 完了条件に実測値を書く**

0 章の表の末尾に 1 行:

```markdown
| `pnpm run ci`(cold、計画 A 完了後) | <Step 2 の elapsed> | A1 の基準値 <A1 の値> から <差分> 短縮 |
```

10 章「計画 A の完了条件」の直後に 1 行:

```markdown
- 計画 A の実測(<日付>): cold `pnpm run ci` <elapsed>、`gen_long_12_other` <秒>、`batch:diff` 一致、ゴールデン不変。
```

`<…>` は Step 2 / Step 3 の実測値で置き換える(数値の無い状態でコミットしない)。

- [ ] **Step 5: コミット**

```powershell
git add docs/superpowers/specs/2026-09-06-ci-optimization-design.md
git commit -m "docs(superpowers): CI 最適化 計画 A の完了実測を設計書へ記す

Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF"
```
