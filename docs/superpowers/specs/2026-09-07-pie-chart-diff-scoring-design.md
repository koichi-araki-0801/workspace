# pie-chart 採点の差分計算(計画 C2)設計書

- 日付: 2026-09-07(dig)/ 2026-09-08(設計)
- 対象: `pie-chart` のラベル配置で、候補ごとに走る採点(`measureRepairVec`)の対判定を
  差分計算へ置き換える。**SVG 出力のバイト不変が鉄則**。
- dig 記録: `docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-dig.md`(Q1〜Q9 決定済み)
- 前提計画: `docs/superpowers/specs/2026-09-06-ci-optimization-design.md` 2 章(段 1〜4 は実装済み。
  本計画は 2.2 節が「別計画送り」と書いた残りの熱源を扱う)

## 1. 目的と非目的

配置計算の時間の大半は、候補配置ごとに 9 指標を数え直す採点に消える。そのうち重いのは
2 指標だけで、どちらも O(n²) の対判定を毎回ゼロから行う。

| 指標 | 中身 | 実測(`profile:synthetic`、tsx 経路) |
|---|---|---|
| `through` | leader が他ラベル箱を貫く対 | 約 18.5 秒 |
| `cross` | leader 同士が交差する対 | 約 4.4 秒 |
| 他 7 指標 | O(n) か四則の O(n²) | 合計でも桁が違う |

候補ループでは 1 つの placement しか動かないのに、動いていない対まで数え直している。
**目的**は、動いた index に関わる対だけを再判定し、残りを基準から再利用すること。

**非目的**: 出力の変化、配置アルゴリズムの変更、早期打ち切り、`EMIT_REPAIR_PASSES` の
順序・stage の変更。CI 経路(vitest)での受入条件 5 秒は計画 A で達成済みで、本計画は
**任意の改善**である(バイト不変を保ったまま速くする)。

## 2. 中核の考え方

採点 1 回が読む幾何は `LeaderGeometry`(`paths` / `boxes` / `pixelBoxes`)。候補ループは既に
`collectLeaderGeometry` を 1 回作り `replaceLeaderGeometryAt(base, …, i)` で index `i` の幾何だけ
差し替えている。同じ発想を**対判定の結果**へ広げる。

- 基準となる対判定の行列(`cross` と `through`)を候補ループの手前で 1 回作る。
- 候補ごとに、**動いた index を含む対だけ**を再判定し、それ以外は行列から読む。
- 動いていない index 同士の対は、幾何が同一なので判定結果も同一。これが正しさの全て。

残り 7 指標は軽いので差分化しない。`geo` から従来どおり全件計算する(FP 演算の順序も同じ
なので値は不変)。

## 3. 適用範囲

dig で全 11 呼び出しサイトを棚卸しした(S1〜S11)。差分化するのは**単一 placement または
小さな index 集合が動くサイト**だけ。

| # | サイト | 動く placement | 扱い |
|---|---|---|---|
| S1 | `tryBendGridOn` 候補ループ(`emit_repair.ts:1839`) | 1 件 | **差分**。回数の主因 |
| S2 | `tryRebendInvolved` bend 格子(`:1901`) | 1 件 | **差分**。回数の主因 |
| S3 | 水平 pie-clear シフト(`:1945`) | 1 件 | **差分** |
| S4 | 複合手(`:1967`) | `p` + 交差相手 `j` 群 | **差分**(変化 index 集合を渡す) |
| S5 | 左 rim 再ハグ(`:1992`) | 1 件 | 全走査のまま(実測で悪化。5.3 節) |
| S6 | 交差対スワップ(`:2064`) | 2 件 | **差分** |
| S7 | 左列再積み(`:2126`) | 左列全体 | 全走査のまま |
| S8 | `repairResidualLeaderDefects` の iter 頭(`:2167`) | 直前の 1 手 | 全走査のまま(6 回以内) |
| S9 | seam 累積プレフィックス探索(`mode_passes.ts:1883/1886`) | 1 件 | **全走査のまま** |
| S10 | seam greedy の採点(`mode_passes.ts:1852` 系) | 1 件 | 対象外(`measureRepairVec` 経由でない) |
| S11 | パス前後の計測(`:2393/2395`) | パス全体 | 全走査のまま |

S9 を外すのは意図的な判断である。`thorough=true` は emit 最終段のみ、`explorePrefix` は
最大 2 回 × 候補 ≤ n なので 1 チャートあたり ≤ 2(n+1) 回(n=12 で 26 回、全体 45,189 回の
0.06%)。「採用した手の差分を基準へ書き戻す」API を 1 サイトのために増やすと、巻き戻し
(`seamRestore` / `bestSnap`)との整合を検証する負担だけが増える。

## 4. 差分 API

### 4.1 基準状態

```ts
/** 候補ループ 1 回のあいだ使い回す採点の基準。寿命はループの中に閉じる。 */
interface ScoreBase {
  geo: LeaderGeometry;
  /** cross の対判定。`crossMat[i][j]`(i < j)が true なら leader i と j が交差する。 */
  crossMat: boolean[][];
  /** through の対判定。`throughMat[i][j]` が true なら leader i が box j を貫く(i ≠ j)。 */
  throughMat: boolean[][];
}
```

**呼び出し側ローカルに作る**。モジュールグローバルへは置かない(2.3 節「モジュールグローバルの
メモを新設しない」)。既存の `const base = collectLeaderGeometry(...)` と同じ寿命・同じ置き場。

### 4.2 差分採点

```ts
function measureRepairVecDelta(
  base: ScoreBase,
  placements: Placement[],
  cfg: PieLayoutConfig,
  coord: Coord,
  changed: readonly number[],
): RepairVec;
```

- `changed` は「この候補で動いた placement の index」。**保守的に読む**: その index は
  path も box も変わりうるとみなし、`cross` の (i,·)、`through` の (i→·) と (·→i) を全部
  再判定する。「box は bend を読まない」といった別の不変則に正しさを預けない。
- `changed.length >= placements.length` なら内部で全走査へ落ちる(呼び出し側は場合分けしない)。
- 戻り値は `measureRepairVecFrom` と**同じ型・同じ値**でなければならない。

### 4.3 同名スライスのフォールバック

`cross` / `through` の値は index 対の個数ではなく、**スライス名をキーにした `Set` の `.size`**
(`"名A×名B"` / `"名A>名B"`)。同名スライスが 2 つあると、別々の対が 1 つのキーへ潰れる。
`normalizeAndSortItems` は同名を拒否も併合もしない。

- 入力契約(記録のみ、コードは依存しない): スライス名は一意。入力は DB のストアドプロシージャで
  整形済みで、同名ラベルは発生しない。
- コード側の守り: `ScoreBase` を作る時点で名前の一意性を確認し、**同名が 1 組でもあれば
  差分を使わず全走査へフォールバックする**。分岐はこの 1 つだけで、等価性は自明になる。
  落ちるのは**対判定の数え方**だけで、幾何(`geo`)は `changed` から作った差し替え版をそのまま
  使う。`changed` が正しければ両者は同値なので、これで値は変わらない。

## 5. 計測と受入条件

### 5.1 カウンタ

`segmentsIntersect` / `leaderCrossesBox`(`layout/geometry.ts` の純関数)は `cfg` を受け取らない。
熱源そのものは触らず、**呼び出し側**の `crossingPairsFrom` / `throughPairsFrom` とその差分版で
1 対につき `cfg.perfCounters.pairTests` を 1 増やす。`...From` 系の署名に `cfg` を 1 引数足す
(呼び出しは `emit_repair.ts` / `leader_geometry.ts` の中に閉じる)。

`perfCounters` は既存の仕組みで、`profile_synthetic.ts` から与えたときだけ有効。既定は無効。

### 5.2 手順

1. **カウンタを先に単独コミットする**(差分化より前)。基準値と実測値を同じ計数規則で取るため。
2. `npm run profile:synthetic gen_long_12_other` / `gen_long_14_other` で基準値を取る。
3. 差分化を実装する。
4. 同じ 2 ケースで実測し、削減率を下の表へ書く。

`seconds` は tsx の `keepNames` で約 3 倍に水増しされるため、比較は**回数**で行う。

### 5.3 受入条件

| ケース | `pairTests` 基準値 | 実測値 | 削減率 | 理論値(全体の上限) |
|---|---|---|---|---|
| `gen_long_12_other` | 10,417,374 | 3,669,048 | 64.8% | 約 70.8%(採点 1 回では 6 分の 1) |
| `gen_long_14_other` | 15,376,088 | 7,141,070 | 53.6% | 約 59.1%(採点 1 回では 7 分の 1) |

実測はいずれも上限のおよそ 9 割(n=12 で 91.5%、n=14 で 90.6%)に達している。残る差は
`buildScoreBase` が基準行列を作る費用(候補ループ 1 回につき全走査 1 回ぶん)で、上限の式は
これを勘定していない。想定内であり取りこぼしではない。

上限の計算に使う「採点 1 回あたりの対数」は leader を全件描く場合の値で、実際には leader を
描かない配置があるぶん下回る。表の数値から機械的に計算すると n=12 の上限は 71.6%(達成度
90.5%)になるが、実効の上限はそれよりわずかに低い。いずれにせよ達成度は約 9 割である。

差分化を見送ったサイトが 1 つある。左 rim 再ハグ(3 章 S5)は 1 候補につき 1 回しか採点しない
ため、基準行列を作る費用が差分の節約を上回る(実測で n=12 が +24,057 対、n=14 が +32,175 対)。
ここだけは全走査のままにしてあり、コードにも同じ理由を残している。

参考までに実時間(tsx 経路、`keepNames` で約 3 倍に水増しされるので比較には使わない)は
n=12 が 25.7 秒 → 10.9 秒、n=14 が 37.1 秒 → 20.1 秒。

理論値の根拠: 全走査の採点 1 回は cross `n(n-1)/2` + through `n(n-1)` = `1.5·n(n-1)` 対。
差分(`changed` = 1 index)は cross `(n-1)` + through `2(n-1)` = `3(n-1)` 対。比は `n/2`。

**ただし `pairTests` はパイプライン全体の合計であり、差分化する経路だけの数ではない。**
`countLeaderCrossings` / `countLeaderThroughLabels`(`measureRepairVecFrom` を経由しない
do-no-harm ゲートの前後計測)が基準値の相当部分を占める(n=12 の基準 1,041 万対に対し、
`measureRepairVec` 45,189 回 × 198 対 = 約 895 万対が採点由来で、残り約 15% がゲート由来。
n=14 では 1,538 万対のうち採点由来が約 1,062 万対で、残り約 31%)。差分化はゲート経路を
変えないので、**全体の削減率は「採点由来の割合 × (1 − 2/n)」が上限**になる。

したがって受入は 2 段で見る:
1. 全体の `pairTests` が上の上限に近い割合で減っていること(n=12 なら 6〜7 割減が目安)。
2. 減りが上限から大きく外れる場合は、フォールバックが意図せず効いている(`base.usable` が
   false、`changed.length >= n`)か、差分化したはずのサイトが `vecOf()` を呼んでいる。
   原因を特定してから受入する。**ゲート経路の残存を「取りこぼし」と誤認しないこと。**
削減率が足りないからといって `changed` の意味論を細分化する案(box と path を分けて申告する)
へは進まない — 申告を誤るとバイト不変を静かに破るため、dig で却下済み。

## 6. 等価性の検証

3 段で守る。

1. **property 風の deep-equal**(新規 `pie-chart/test/diff_scoring.test.ts`):
   自前の seeded LCG で placements を生成し、1〜2 件の bend / x / y を動かして
   - `replaceLeaderGeometryAt(collect(P), …, i)` ≡ `collect(P')`(現状これを主張するテストが無い)
   - `measureRepairVecDelta(base, …, changed)` ≡ `measureRepairVecFrom(…全走査)`
   を **9 フィールドすべての deep-equal** で固定する。fast-check は導入しない(オフライン
   重量物バンドルの再生成を伴う)。
2. **同名フォールバックの固定**: 同名スライスを含む入力で、差分経路が全走査と同値を返すこと。
3. **既存のゴールデン**: `batch:diff` の実サンプル 83 件 byte 一致、`render_hash` 定数表 26 行
   (C1 後)、`final_score` / `mark_flags` の `.snap` 不変。

## 7. 完了条件

1. `npm run batch` → `npm run batch:diff` で 83 件が byte 一致。
2. `render_hash` 定数表 26 行・`final_score` / `mark_flags` の `.snap` が不変。
3. 6 章の 3 段(property 風 deep-equal・同名フォールバック・ゴールデン)が緑。
4. `pairTests` が両ケースで 5.3 節に書いた削減率以上。
5. `pnpm run typecheck:pie-chart`・`check:comments`・biome・coverage(既存 include の閾値)が緑。

## 8. してはならないこと(2.3 節との照合)

| 禁止事項 | 本計画での扱い |
|---|---|
| `iterateOverlapPairs` の巻き上げ | 触らない(`post_layout.ts`。差分の対象外) |
| モジュールグローバルのメモ新設 | `ScoreBase` は呼び出し側ローカル。カウンタは既存の `cfg.perfCounters` 経由 |
| `{ ...cfg, textColor }` の cfg コピーを extent 系へ渡す経路 | 作らない。`...From` 系へ足す `cfg` は呼び出し側の同じ参照 |
| 早期打ち切り | 採らない。差分は同じ値を返すだけ |
| `EMIT_REPAIR_PASSES` の順序・stage | 触らない |
| サンプル名指し・per-sample config | 無関係(発火条件は幾何のみ) |

加えて本計画の固有の禁止:

- `changed` の意味論を細分化しない(5.3 節)。
- S9 / S10 を差分化しない(3 章)。`advanceScoreBase` は作らない。
- 同名スライスを差分の整数カウントで扱わない(4.3 節)。

## 9. 実装の順序

1. `pairTests` カウンタ(単独コミット)→ 基準値の計測。
2. `ScoreBase` と `measureRepairVecDelta`(全走査と同値を返すだけの実装。まだ誰も呼ばない)。
3. 等価性テスト 3 段(この時点で緑になる)。
4. S1 / S2 を差分へ切替 → `batch:diff` と ゴールデン → 実測。
5. S3〜S6 を差分へ切替 → 同じ検証 → 実測。
6. 受入条件の表を埋め、設計正典へ 1 行(採点は差分計算・基準はループローカル・同名は
   フォールバック)を残す。

各段でバイト不変を確認する。差分が出た段で止めて原因を特定する(段をまとめない)。
