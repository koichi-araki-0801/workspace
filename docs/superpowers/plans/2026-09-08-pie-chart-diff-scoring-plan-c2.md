# pie-chart 採点の差分計算(計画 C2)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ラベル配置の候補ループで走る採点(`measureRepairVec`)の重い 2 指標(leader 交差 `cross` /
leader×box 貫通 `through`)を差分計算へ置き換え、SVG 出力のバイトを 1 つも変えずに対判定の
回数を減らす。

**Architecture:** 候補ループの手前で対判定の結果を行列(`crossMat` / `throughMat`)として 1 回
作り、候補ごとに「動いた index を含む対」だけを再判定して残りを行列から読む。行列は呼び出し側の
ローカルに持ち、モジュールグローバルへは置かない。採点値は**スライス名をキーにした集合の
要素数**なので、名前が全件一意のときだけ差分を使い、同名が 1 組でもあれば従来の全走査へ落とす。

**Tech Stack:** TypeScript 6 / vitest 4.1.11 / Node 24(pie-chart は依存を足さない)

**Spec:** `docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md`
(dig 記録: `docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-dig.md`)

## Global Constraints

- **SVG 出力のバイト不変が鉄則**: 各タスクの最後に `pnpm --filter pie-chart run batch` →
  `pnpm --filter pie-chart run batch:diff` で実サンプル 83 件が byte 一致すること。1 件でも
  差分が出たらそのタスクで止めて原因を特定する(次のタスクへ進まない)。
- **ゴールデン不変**: `pie-chart/test/helpers/renderHashExpected.ts` の定数表 26 行、
  `test/__snapshots__/final_score.test.ts.snap`、`mark_flags.test.ts.snap` は 1 行も変えない。
- **`changed` は保守的に読む**: `changed` に載った index は「経路も箱も変わりうる」とみなし、
  `cross` の (i,·)、`through` の (i→·) と (·→i) を全部再判定する。「箱は曲げを読まない」等の
  別の不変則に差分の正しさを預けない。細分化案(`{ paths, boxes }` を分けて申告する形)へは
  進まない。
- **同名スライスは差分を使わない**: `ScoreBase` を作る時点で名前の一意性を確かめ、同名が
  1 組でもあれば差分経路を使わず全走査へ落とす。
- **してはならないこと**(設計正典 2.3 節 + 本計画固有):
  `post_layout.ts` の `iterateOverlapPairs` は触らない / モジュールグローバルのメモを新設しない /
  `{ ...cfg, textColor }` のような cfg コピーを extent 系へ渡す経路を作らない / 早期打ち切りを
  入れない / `EMIT_REPAIR_PASSES` の順序と stage を触らない / S9(seam 累積探索)と S10(seam
  greedy)は差分化しない / `advanceScoreBase` のような「採用した手を基準へ書き戻す」API を作らない。
- **コメント規約**(`docs/コメント規約.md`): 「なぜ」を日本語散文で書く。日付・所見番号・
  経緯・「以前は」は書かない。識別子はバッククォート。
- **コミット**: 日本語のメッセージ、末尾に
  `Claude-Session: https://claude.ai/code/session_01HJBY6TRF9GRttvDdb9MaQF`。`git add` は明示
  ファイルのみ(同一 checkout で別セッションが作業していることがある。見知らぬ変更に触らない)。
  post-commit フックが push と pre-push CI(8〜10 分)を走らせる。amend / rebase はしない。
- **重いジョブを重ねない**: `batch` / vitest / profile を走らせる前に
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vitest|playwright|ci-affected' }`
  で他ジョブが無いことを確かめる。

---

### Task 1: 対判定回数のカウンタ(基準値を取る)

**Files:**
- Modify: `pie-chart/src/types.ts`(`PerfCounters` に 1 フィールド)
- Modify: `pie-chart/src/svg_export/leader_geometry.ts`(`crossingPairsFrom` / `throughPairsFrom` と
  その呼び出し 4 箇所)
- Modify: `pie-chart/scripts/profile_synthetic.ts`(カウンタの初期値)

**Interfaces:**
- Produces: `PerfCounters.pairTests: number`(対判定を 1 対行うごとに 1 増える)。
  `crossingPairsFrom(placements, paths, cfg?)` / `throughPairsFrom(placements, paths, pixelBoxes, cfg?)`
  が `cfg` を任意引数で受ける。`countLeaderCrossingsFrom(placements, geo, cfg?)` /
  `countLeaderThroughLabelsFrom(placements, geo, cfg?)` も同様。

差分化の前に**基準値を同じ計数規則で取る**ためのタスク。熱源の純関数(`segmentsIntersect` /
`leaderCrossesBox`。`layout/geometry.ts`)は触らず、呼び出し側で数える。

- [ ] **Step 1: カウンタのフィールドを足す**

`pie-chart/src/types.ts` の `PerfCounters`:

```ts
export interface PerfCounters {
  placementBox: number;
  realLeaderPaths: number;
  measureRepairVec: number;
  tryBendGridOn: number;
  /**
   * 対判定の回数 (leader 同士の交差 1 対 + leader と box の貫通 1 対を、それぞれ 1 と数える)。
   * 採点の計算量そのもので、差分計算の効き目はこの回数の減りで測る (壁時計はトランスパイラの
   * オーバーヘッドを含むため段階間の比較に使えない)。
   */
  pairTests: number;
}
```

- [ ] **Step 2: 対判定の場所で数える**

`pie-chart/src/svg_export/leader_geometry.ts` の 2 つの内部関数へ `cfg` を任意引数で足し、
対を 1 つ調べるごとに数える。`crossingPairsFrom`:

```ts
function crossingPairsFrom(
  placements: Placement[],
  paths: (Pt[] | null)[],
  cfg?: PieLayoutConfig,
): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < paths.length; i += 1) {
    const pa = paths[i];
    if (!pa) continue;
    for (let j = i + 1; j < paths.length; j += 1) {
      const pb = paths[j];
      if (!pb) continue;
      if (cfg?.perfCounters) cfg.perfCounters.pairTests += 1;
      if (!pathsCross(pa, pb)) continue;
      const [x, y] = [placements[i].item.name, placements[j].item.name].sort();
      pairs.add(`${x}×${y}`);
    }
  }
  return pairs;
}
```

`throughPairsFrom` も同じ形(`if (cfg?.perfCounters) cfg.perfCounters.pairTests += 1;` を
`leaderCrossesBox` の直前に置く)。**`!pb` / `j === i` で `continue` する分は数えない**
(実際に判定していないため)。

`countLeaderCrossingsFrom` / `countLeaderThroughLabelsFrom` / `leaderCrossingPairs` /
`leaderThroughPairs` に `cfg?` を通し、内部関数へ渡す。`measureRepairVecFrom`
(`emit_repair.ts:1588`)からの呼び出しは `cfg` を渡す(その関数は既に `cfg` を持っている)。

- [ ] **Step 3: profile スクリプトの初期値へ足す**

`pie-chart/scripts/profile_synthetic.ts` の `perfCounters` リテラルへ `pairTests: 0,` を足す。

- [ ] **Step 4: 型と既存テストを通す**

Run: `pnpm run typecheck:pie-chart && pnpm exec vitest run --project pie-chart`
Expected: 型 exit 0、テスト全緑(カウンタは既定無効なので挙動は変わらない)。

- [ ] **Step 5: バイト不変を確認する**

Run: `pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff`
Expected: `[batch:diff] OK — 全 83 件が baseline と byte 一致`。

- [ ] **Step 6: 基準値を測って報告書へ記録する**

Run:
```bash
pnpm --filter pie-chart run profile:synthetic gen_long_12_other
pnpm --filter pie-chart run profile:synthetic gen_long_14_other
```
出力 JSON の `pairTests`(と `measureRepairVec`)を報告書へ写す。この 2 つが**差分化後の
比較基準**になる。

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write pie-chart/src/types.ts pie-chart/src/svg_export/leader_geometry.ts pie-chart/scripts/profile_synthetic.ts
git add pie-chart/src/types.ts pie-chart/src/svg_export/leader_geometry.ts pie-chart/scripts/profile_synthetic.ts
git commit -m "perf(pie-chart): 対判定の回数を数えるカウンタを足して採点の計算量を測れるようにする"
```

---

### Task 2: `ScoreBase` と差分採点 API(まだ誰も呼ばない)

**Files:**
- Modify: `pie-chart/src/svg_export/leader_geometry.ts`(行列の生成と差分判定を追加)
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(`measureRepairVecDelta` を追加)
- Test: `pie-chart/test/diff_scoring.test.ts`(新規)

**Interfaces:**
- Consumes: `LeaderGeometry` / `collectLeaderGeometry` / `replaceLeaderGeometryAt`
  (`leader_geometry.ts`)、`measureRepairVecFrom(placements, cfg, coord, geo)`
  (`emit_repair.ts:1588`)、Task 1 の `cfg.perfCounters.pairTests`。
- Produces:
  - `interface ScoreBase { geo: LeaderGeometry; crossMat: boolean[][]; throughMat: boolean[][]; usable: boolean }`
    (`leader_geometry.ts` で export)
  - `buildScoreBase(placements, cfg, coord): ScoreBase`(同上)
  - `crossCountWithChanged(placements, geo, base, changed, cfg): number`(同上)
  - `throughCountWithChanged(placements, geo, base, changed, cfg): number`(同上)
  - `measureRepairVecDelta(base, placements, cfg, coord, changed): RepairVec`(`emit_repair.ts` で export)

- [ ] **Step 1: 失敗するテストを書く**

`pie-chart/test/diff_scoring.test.ts`:

```ts
// =============================================================================
// diff_scoring.test.ts — 差分採点が全走査と同値であることの固定
// =============================================================================
// 差分計算は「動いていない index の対判定を再利用する」ことなので、正しさは「全走査と同じ値を
// 返す」に尽きる。実配置の分布に依存しない性質なので、決定的な擬似乱数で作った配置を動かして
// 9 フィールドすべてを突き合わせる。`replaceLeaderGeometryAt` が `collectLeaderGeometry` と
// 同値であることも同時に固定する (この 2 つの一致は差分の前提で、これまで byte 比較だけが網だった)。
import { describe, expect, it } from 'vitest';
import { createPieLayoutConfig } from '../src/config.js';
import { measureRepairVecDelta, measureRepairVecFrom } from '../src/svg_export/emit_repair.js';
import {
  buildScoreBase,
  collectLeaderGeometry,
  replaceLeaderGeometryAt,
} from '../src/svg_export/leader_geometry.js';
import { renderPdfStylePieToSvg } from '../src/svg_export/pipeline.js';
import { syntheticCases } from './helpers/syntheticCases.js';

/** 決定的な擬似乱数 (seed 固定の線形合同法)。外部依存を足さないための最小実装。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
```

`placements` を外から作る手段が要る。`pipeline.ts` の内部で作られるため、テストからは
**実際の配置を 1 回作って取り出す**のが確実である。`renderPdfStylePieToSvg` は SVG しか
返さないので、次の 2 つのうち実装しやすい方を選ぶ(実装者が選び、報告書に理由を書く):

- (a) `pipeline.ts` から `layoutPlacementsForTest(items, cfg)` のような**テスト用の export を
  足さない**で、`layoutLabels`(`layout/diagnostics.ts`)+ `runLabelCascade` の公開 API を
  テスト内で組み合わせて placements を作る。
- (b) 既存の `verify/svg.ts` などが placements 相当を作っていればそれを使う。

どちらも取れない場合は `pipeline.ts` に**テスト専用の export を足さない**方針を守り、
`layoutLabels` の戻り値から `Placement[]` を構成する経路を報告書に記録したうえで進める。

主張は 3 つ:

```ts
describe('差分採点は全走査と同値', () => {
  const cfg = createPieLayoutConfig({});
  const items = syntheticCases().gen_long_12_other;

  it('replaceLeaderGeometryAt は collectLeaderGeometry と同じ幾何を返す', () => {
    const { placements, coord } = makePlacements(items, cfg); // 上で決めた経路
    const rnd = lcg(20260908);
    for (let t = 0; t < 20; t += 1) {
      const i = Math.floor(rnd() * placements.length);
      placements[i].x += (rnd() - 0.5) * 4;
      placements[i].y += (rnd() - 0.5) * 4;
      const base = collectLeaderGeometry(placements, cfg, coord);
      placements[i].leaderBend = { x: (rnd() - 0.5) * 10, y: (rnd() - 0.5) * 10 };
      expect(replaceLeaderGeometryAt(base, placements, cfg, coord, i)).toEqual(
        collectLeaderGeometry(placements, cfg, coord),
      );
    }
  });

  it('measureRepairVecDelta は measureRepairVecFrom と 9 フィールドすべて一致する', () => {
    const { placements, coord } = makePlacements(items, cfg);
    const rnd = lcg(4242);
    for (let t = 0; t < 30; t += 1) {
      const base = buildScoreBase(placements, cfg, coord);
      const changed = [Math.floor(rnd() * placements.length)];
      if (rnd() < 0.3) changed.push(Math.floor(rnd() * placements.length));
      for (const i of changed) {
        placements[i].x += (rnd() - 0.5) * 6;
        placements[i].leaderBend = { x: (rnd() - 0.5) * 12, y: (rnd() - 0.5) * 12 };
      }
      const geo = changed.reduce(
        (g, i) => replaceLeaderGeometryAt(g, placements, cfg, coord, i),
        base.geo,
      );
      expect(measureRepairVecDelta(base, placements, cfg, coord, changed)).toEqual(
        measureRepairVecFrom(placements, cfg, coord, geo),
      );
    }
  });

  it('同名スライスがあれば差分を使わず全走査へ落ちる', () => {
    const dup = [
      { name: '国内株式', value: 40 },
      { name: '国内株式', value: 35 },
      { name: '現金', value: 25 },
    ];
    const { placements, coord } = makePlacements(dup, cfg);
    const base = buildScoreBase(placements, cfg, coord);
    expect(base.usable).toBe(false);
    placements[0].leaderBend = { x: 3, y: 3 };
    const geo = replaceLeaderGeometryAt(base.geo, placements, cfg, coord, 0);
    expect(measureRepairVecDelta(base, placements, cfg, coord, [0])).toEqual(
      measureRepairVecFrom(placements, cfg, coord, geo),
    );
  });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/diff_scoring.test.ts`
Expected: FAIL(`buildScoreBase` / `measureRepairVecDelta` が存在しない)。

- [ ] **Step 3: `ScoreBase` と行列を作る**

`pie-chart/src/svg_export/leader_geometry.ts` へ追加:

```ts
/**
 * 候補ループ 1 回のあいだ使い回す採点の基準。`crossMat` / `throughMat` は対判定の結果で、
 * 動いていない index どうしの対はここから読む (幾何が同じなら判定も同じ)。
 * 寿命は候補ループの中に閉じる — モジュールへは持たない。
 */
export interface ScoreBase {
  geo: LeaderGeometry;
  /** `crossMat[i][j]` (i < j) が true なら leader i と j が交差する。 */
  crossMat: boolean[][];
  /** `throughMat[i][j]` (i ≠ j) が true なら leader i が box j を貫く。 */
  throughMat: boolean[][];
  /**
   * 差分を使ってよいか。採点値はスライス名をキーにした集合の要素数なので、同名スライスが
   * あると別々の対が 1 つのキーへ潰れ、index 対の数え直しと値が乖離する。名前が全件一意の
   * ときだけ true。
   */
  usable: boolean;
}

export function buildScoreBase(
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
): ScoreBase {
  const geo = collectLeaderGeometry(placements, cfg, coord);
  const n = placements.length;
  const names = new Set(placements.map((p) => p.item.name));
  const usable = names.size === n;
  const crossMat = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const throughMat = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  if (!usable) return { geo, crossMat, throughMat, usable };
  for (let i = 0; i < n; i += 1) {
    const pa = geo.paths[i];
    if (!pa) continue;
    for (let j = i + 1; j < n; j += 1) {
      const pb = geo.paths[j];
      if (!pb) continue;
      if (cfg.perfCounters) cfg.perfCounters.pairTests += 1;
      crossMat[i][j] = pathsCross(pa, pb);
    }
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      if (cfg.perfCounters) cfg.perfCounters.pairTests += 1;
      throughMat[i][j] = leaderCrossesBox(pa, geo.pixelBoxes[j]);
    }
  }
  return { geo, crossMat, throughMat, usable };
}
```

- [ ] **Step 4: 差分の数え上げを書く**

同じファイルへ:

```ts
/** `changed` に載った index が絡む対だけを再判定し、残りは `base` の行列から読んで数える。 */
export function crossCountWithChanged(
  placements: Placement[],
  geo: LeaderGeometry,
  base: ScoreBase,
  changed: ReadonlySet<number>,
  cfg: PieLayoutConfig,
): number {
  const pairs = new Set<string>();
  const n = placements.length;
  for (let i = 0; i < n; i += 1) {
    const pa = geo.paths[i];
    if (!pa) continue;
    for (let j = i + 1; j < n; j += 1) {
      const pb = geo.paths[j];
      if (!pb) continue;
      let hit: boolean;
      if (changed.has(i) || changed.has(j)) {
        if (cfg.perfCounters) cfg.perfCounters.pairTests += 1;
        hit = pathsCross(pa, pb);
      } else {
        hit = base.crossMat[i][j];
      }
      if (!hit) continue;
      const [x, y] = [placements[i].item.name, placements[j].item.name].sort();
      pairs.add(`${x}×${y}`);
    }
  }
  return pairs.size;
}
```

`throughCountWithChanged` も同じ形(内側ループは `j === i` を飛ばし、キーは
`` `${placements[i].item.name}>${placements[j].item.name}` ``、判定は
`leaderCrossesBox(pa, geo.pixelBoxes[j])`)。

**`null` の扱いに注意**: 基準を作ったときに `paths[i]` が `null`(leader を描かない)でも、
候補で `null` でなくなることがある。`hit` の分岐は上のとおり「`changed` に載っていれば必ず
再判定」なので、`changed` の index については行列を読まない。動いていない index の `null`
判定は基準と同じ(幾何が同じ)なので `continue` の位置が変わることはない。

- [ ] **Step 5: `measureRepairVecDelta` を書く**

`pie-chart/src/svg_export/emit_repair.ts` の `measureRepairVecFrom` の直後へ:

```ts
/**
 * `base` を基準に、`changed` に載った placement が絡む対判定だけを数え直して採点する。
 * `changed` の index は **経路も箱も変わりうる** とみなす (呼び出し側が「箱は動いていない」を
 * 自己申告する形にすると、申告を誤ったときに出力が静かに変わる)。同名スライスがある入力
 * (`base.usable === false`) と、変化が全件に及ぶ場合は全走査へ落ちる。
 */
export function measureRepairVecDelta(
  base: ScoreBase,
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  changed: readonly number[],
): RepairVec {
  const geo = changed.reduce(
    (g, i) => replaceLeaderGeometryAt(g, placements, cfg, coord, i),
    base.geo,
  );
  if (!base.usable || changed.length >= placements.length) {
    return measureRepairVecFrom(placements, cfg, coord, geo);
  }
  if (cfg.perfCounters) cfg.perfCounters.measureRepairVec += 1;
  const set = new Set(changed);
  return {
    cross: crossCountWithChanged(placements, geo, base, set, cfg),
    pieCross: leaderPieCrossCountFrom(geo.paths, cfg, coord),
    through: throughCountWithChanged(placements, geo, base, set, cfg),
    inv: countAngularDiscordantPairsFrom(placements, coord, geo),
    clips: geo.boxes.filter((lb) => boxViewOverflowOfBox(lb, coord) > 1).length,
    oob: oobLeaderCountFrom(geo.paths, coord),
    ovl: boxOverlapMaxOf(geo.boxes),
    boxPie: boxPieIntrusionMaxOf(placements, geo.boxes, cfg),
    view: boxViewOverflowMaxOf(geo.boxes, coord),
  };
}
```

`cross` / `through` 以外の 7 指標は `measureRepairVecFrom` と**同じ式・同じ順序**で書く
(値が FP で一致することが要件)。

- [ ] **Step 6: テストを通す**

Run: `pnpm exec vitest run --project pie-chart pie-chart/test/diff_scoring.test.ts`
Expected: 3 件 PASS。

- [ ] **Step 7: 既存の全テストとバイト不変**

Run: `pnpm exec vitest run --project pie-chart && pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff`
Expected: 全緑、83 件 byte 一致(この時点では新 API を誰も呼んでいないので当然だが、
`buildScoreBase` の追加が既存経路へ漏れていないことの確認になる)。

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts pie-chart/test/diff_scoring.test.ts
git add pie-chart/src/svg_export/leader_geometry.ts pie-chart/src/svg_export/emit_repair.ts pie-chart/test/diff_scoring.test.ts
git commit -m "perf(pie-chart): 採点の基準となる対判定行列と差分採点 API を足す(まだ呼び出さない)"
```

---

### Task 3: 曲げ格子の 2 ループを差分へ切り替える(回数の主因)

**Files:**
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(`tryBendGridOn` `:1839` 付近、
  `tryRebendInvolved` `:1901` 付近)

**Interfaces:**
- Consumes: Task 2 の `buildScoreBase` / `measureRepairVecDelta`。
- Produces: なし(呼び出しの切替のみ)。

この 2 箇所が採点回数の主因(格子 30 候補 × 関与 leader × 最大 6 反復)。既に
`collectLeaderGeometry` を 1 回作って `replaceLeaderGeometryAt` で差し替えているので、
その `base` を `buildScoreBase` へ替え、採点を `measureRepairVecDelta(base, …, [i])` にする。

- [ ] **Step 1: `tryBendGridOn` を切り替える**

現在の形(`emit_repair.ts:1836` 付近):

```ts
  const i = placements.indexOf(p);
  const base = i >= 0 ? collectLeaderGeometry(placements, cfg, coord) : null;
  const measure = (): ResidualVec =>
    base
      ? toResidualVec(
          measureRepairVecFrom(
            placements,
            cfg,
            coord,
            replaceLeaderGeometryAt(base, placements, cfg, coord, i),
          ),
        )
      : vecOf();
```

これを:

```ts
  const i = placements.indexOf(p);
  const base = i >= 0 ? buildScoreBase(placements, cfg, coord) : null;
  const measure = (): ResidualVec =>
    base ? toResidualVec(measureRepairVecDelta(base, placements, cfg, coord, [i])) : vecOf();
```

`tryRebendInvolved`(`:1898` 付近)の `base` も同じ形へ替える(`bendFeasible ? buildScoreBase(...) : null`、
採点は `measureRepairVecDelta(base, placements, cfg, coord, [i])`)。

- [ ] **Step 2: バイト不変を確認する**

Run: `pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff`
Expected: 83 件 byte 一致。**1 件でも差分が出たらここで止める**(差分採点の値が全走査と
食い違っている。Task 2 のテストを増やして再現させること)。

- [ ] **Step 3: ゴールデンと全テスト**

Run: `pnpm exec vitest run --project pie-chart`
Expected: 全緑(`render_hash` 26 ケース、`final_score`、`mark_flags` を含む)。

- [ ] **Step 4: 削減率を測る**

Run:
```bash
pnpm --filter pie-chart run profile:synthetic gen_long_12_other
pnpm --filter pie-chart run profile:synthetic gen_long_14_other
```
Task 1 の基準値と比べ、`pairTests` の削減率を報告書へ書く。理論値は 1 回あたり n/2
(12 スライスで 6 分の 1、14 で 7 分の 1)。**大きく下回る場合**は、全走査へのフォールバックが
意図せず効いている(`base.usable` が false、`changed.length >= n`)か、差分化したはずの経路が
`vecOf()` を呼んでいる。原因を特定してから次へ進む。

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write pie-chart/src/svg_export/emit_repair.ts
git add pie-chart/src/svg_export/emit_repair.ts
git commit -m "perf(pie-chart): 曲げ格子の候補採点を差分計算へ切り替える"
```

---

### Task 4: 単一配置を動かす残りのサイトを差分へ切り替える

**Files:**
- Modify: `pie-chart/src/svg_export/emit_repair.ts`(水平シフト `:1945` 付近、複合手 `:1967` 付近、
  左 rim 再ハグ `:1992` 付近、交差対スワップ `trySwapCrossingPairs` `:2064` 付近)

**Interfaces:**
- Consumes: Task 2 の `buildScoreBase` / `measureRepairVecDelta`、`tryBendGridOn(ctx, p): boolean`
  (採否を返す。変化 index 集合を組み立てるのに使う)。
- Produces: なし。

これらは 1 手につき 1〜数回で効果は小さいが、同じ API で扱えるので分岐を増やさずに済む。
**サイトごとに「何が動くか」を明示してから切り替える**こと。

- [ ] **Step 1: 水平 pie-clear シフト(S3)を切り替える**

`p.x += targetRight - lb.right; clampPlacement(p);` の直**前**で基準を作り、直後の `vecOf()` を
差分へ替える。動くのは `p` 1 件:

```ts
        if (lb.right > targetRight) {
          const iP = placements.indexOf(p);
          const shiftBase = iP >= 0 ? buildScoreBase(placements, cfg, coord) : null;
          p.x += targetRight - lb.right;
          clampPlacement(p);
          let v = shiftBase
            ? toResidualVec(measureRepairVecDelta(shiftBase, placements, cfg, coord, [iP]))
            : vecOf();
```

- [ ] **Step 2: 複合手(S4)を切り替える**

同じブロックの後半、`tryBendGridOn` を `p` と交差相手 `placements[j]` へ掛けた後の 2 度目の
`vecOf()`。動くのは `p` + **採用された** `j` 群なので、採否(`tryBendGridOn` の戻り値)で集める:

```ts
            const movedIdx = new Set<number>([iP]);
            if (tryBendGridOn(ctx, p)) movedIdx.add(iP);
            // …交差相手のループ内…
                  if (tryBendGridOn(ctx, placements[j])) movedIdx.add(j);
            // …
            v = shiftBase
              ? toResidualVec(
                  measureRepairVecDelta(shiftBase, placements, cfg, coord, [...movedIdx]),
                )
              : vecOf();
```

`tryBendGridOn` は内部で採用しなければ元へ戻すので、**戻り値が false の相手は動いていない**。
`p` 自身は Step 1 で既に動いているので、採否に関わらず `movedIdx` へ入れる。

- [ ] **Step 3: 左 rim 再ハグ(S5)を切り替える**

`trySeamMutation(placements, () => reshapeToLeftRimHug(...), () => { const v = vecOf(); … })` の
形。`mutate` の前に基準を作り、`isBetter` の中を差分へ替える。動くのは `p` 1 件:

```ts
        const iP = placements.indexOf(p);
        const hugBase = iP >= 0 ? buildScoreBase(placements, cfg, coord) : null;
        adopted = trySeamMutation(
          placements,
          () => reshapeToLeftRimHug(p, cfg, placementBox(p, cfg).top),
          () => {
            const v = hugBase
              ? toResidualVec(measureRepairVecDelta(hugBase, placements, cfg, coord, [iP]))
              : vecOf();
            const ok = better(v, cur);
            // 既存のデバッグ出力はそのまま
            return ok;
          },
        );
```

- [ ] **Step 4: 交差対スワップ(S6)を切り替える**

`trySwapCrossingPairs` は 2 つの placement の x / y / baseline を交換する。基準を交換の前に
作り、採点を `[ia, ib]` の差分へ替える(具体的な行はファイルを読んで合わせる。交換の対象
index はループ変数として既にある)。

- [ ] **Step 5: バイト不変とゴールデン**

Run: `pnpm --filter pie-chart run batch && pnpm --filter pie-chart run batch:diff && pnpm exec vitest run --project pie-chart`
Expected: 83 件 byte 一致、全テスト緑。**差分が出たらここで止める**。どのサイトが原因かは
Step 1〜4 を 1 つずつ戻して切り分ける。

- [ ] **Step 6: 削減率を測る**

Run: `pnpm --filter pie-chart run profile:synthetic gen_long_12_other && pnpm --filter pie-chart run profile:synthetic gen_long_14_other`
Task 3 の値と比べ、追加の減りを報告書へ書く(小さいはず。増えていたら基準の作り直しが
多すぎる = `buildScoreBase` を毎手呼んでいる箇所を見直す)。

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write pie-chart/src/svg_export/emit_repair.ts
git add pie-chart/src/svg_export/emit_repair.ts
git commit -m "perf(pie-chart): 水平シフト・複合手・左 rim 再ハグ・交差対スワップの採点も差分にする"
```

---

### Task 5: 受入条件の記入と設計正典への追記

**Files:**
- Modify: `docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md`(5.3 節の表)
- Modify: `docs/pie-chart/src/設計正典.md`(採点の節へ 1 項)

**Interfaces:**
- Consumes: Task 1 / 3 / 4 で測った `pairTests` の値。
- Produces: なし。

- [ ] **Step 1: 受入条件の表を埋める**

設計書 5.3 節の表へ、Task 1 の基準値・Task 4 後の実測値・削減率・理論値を書く。理論値を
大きく下回る場合は、その理由(どのサイトが全走査のまま残っているか)を 2 行以内で添える。

- [ ] **Step 2: 設計正典へ 1 項足す**

`docs/pie-chart/src/設計正典.md` の「採点と scorer ↔ emit の一致保証」節の末尾へ:

```markdown
- 候補ループの採点は**差分計算**で行う(`measureRepairVecDelta`)。基準の対判定行列
  (`ScoreBase`)は候補ループのローカルに持ち、動いた index は「経路も箱も変わりうる」と
  保守的に扱う。採点値はスライス名をキーにした集合の要素数なので、**同名スライスがある入力では
  差分を使わず全走査へ落ちる**(名前の一意性は `buildScoreBase` が確かめる)。多数の placement が
  動くサイト(左列再積み・パス前後の計測・seam の累積探索)は全走査のまま。
```

- [ ] **Step 3: 最終確認**

Run: `pnpm run check:comments && pnpm run typecheck:pie-chart && pnpm exec vitest run --project pie-chart && pnpm --filter pie-chart run batch:diff`
Expected: すべて exit 0、83 件 byte 一致。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md docs/pie-chart/src/設計正典.md
git commit -m "docs(pie-chart): 差分採点の受入実測を設計書へ記入し、不変則を設計正典へ残す"
```

---

## Self-Review

- **Spec coverage**: 2 章(中核の考え方)= Task 2。3 章(適用範囲 S1〜S6)= Task 3・4。
  4 章(差分 API・同名フォールバック)= Task 2。5 章(計測と受入)= Task 1・3・4・5。
  6 章(等価性の 3 段)= Task 2 の Step 1(property 風 + 同名)と各タスクの `batch:diff`。
  7 章(完了条件 5 項)= Task 5 Step 3 + 各タスクのバイト不変。8 章(禁止事項)= Global Constraints。
- **Placeholder scan**: 各 Step にコードと期待結果がある。Task 2 Step 1 の「placements をどう
  作るか」だけは実装者の選択に委ねているが、選択肢を 2 つ挙げ、`pipeline.ts` へテスト専用
  export を足さない制約を明示した(この 1 点は実装時にファイルを読まないと決められない)。
- **Type consistency**: `ScoreBase` / `buildScoreBase` / `crossCountWithChanged` /
  `throughCountWithChanged` / `measureRepairVecDelta` の名前と引数順は Task 2 の定義と
  Task 3・4 の呼び出しで一致。`changed` は `readonly number[]`(API)と `ReadonlySet<number>`
  (内部の数え上げ)で使い分け、変換は `measureRepairVecDelta` の中で 1 回だけ行う。
