# pie-chart 採点の差分計算(計画 C2)— dig 調査記録

- 日付: 2026-09-07
- 対象: `measureRepairVec` の対判定(leader 交差 / leader×box 貫通)を差分計算にして
  配置計算を速くする。SVG 出力のバイト不変が鉄則。
- 状態: **完了**(Round 3 で全論点確定。次は brainstorming → spec)
- 背景: `docs/superpowers/specs/2026-09-06-ci-optimization-design.md` 2.2 節の「別計画送り」。
  計画 A で段 1(計測フック)・段 2(幾何の 1 回計算)・段 3(`placementExtent` メモ)・
  段 4(bend 格子の幾何差し替え)は実装済み(`b9dfe04` / `b671cfd` / `12cfac6`)。

## 既存資産(前提。2026-09-07 時点の実装から)

- `measureRepairVecFrom(placements, cfg, coord, geo)`(`emit_repair.ts:1588`)が 9 指標を
  `LeaderGeometry`(`paths` / `boxes` / `pixelBoxes`)から読む。指標ごとの計算量は次のとおり:

  | 指標 | 依存する幾何 | 計算量 | 中身 |
  |---|---|---|---|
  | `cross` | paths | O(n²) × 折れ線セグメント積 | `crossingPairsFrom` → `pathsCross` → `segmentsIntersect` |
  | `through` | paths × pixelBoxes | O(n²) × セグメント × 4 辺 | `throughPairsFrom` → `leaderCrossesBox` |
  | `pieCross` | paths | O(n) | path 単位 |
  | `inv` | paths の端点 + boxes の縦中心 | O(n log n) | `angularStacksFrom` → Kendall 対 |
  | `clips` / `view` | boxes | O(n) | box 単位 |
  | `oob` | paths | O(n) | path 単位 |
  | `ovl` | boxes | O(n²) だが四則のみ | `boxOverlapMaxOf` |
  | `boxPie` | boxes | O(n) | box 単位 |

  重いのは `cross` と `through` だけ(実測 `profile:synthetic` で `throughPairsFrom` 約 18.5 秒 /
  `crossingPairsFrom` 約 4.4 秒。他は合計でも桁が違う)。
- `cross` / `through` の値は**スライス名をキーにした `Set` の `.size`**
  (`"名A×名B"` / `"名A>名B"`)。index 対の個数ではない。`normalizeAndSortItems`
  (`pipeline.ts:966`)は同名スライスを拒否も併合もしない。
- bend 格子の 2 ループ(`tryBendGridOn` `emit_repair.ts:1839`、`tryRebendInvolved` `:1901`)は
  `collectLeaderGeometry` を 1 回作り `replaceLeaderGeometryAt(base, …, i)` で index `i` の
  幾何だけ差し替えている。候補間で動くのは `leaderBend` と follows フラグ 2 つで、
  **box は bend を読まない**ため box は全件不変、path は `i` だけが変わる。
- `replaceLeaderGeometryAt` ≡ `collectLeaderGeometry` を主張する単体テストは無い
  (`batch:diff` と 3 つのゴールデンだけが網)。
- `PerfCounters`(`types.ts`)は `placementBox` / `realLeaderPaths` / `measureRepairVec` /
  `tryBendGridOn` の**呼出回数**。差分化しても `measureRepairVec` の回数は減らないので、
  現行カウンタでは効果が見えない。`segmentsIntersect` / `leaderCrossesBox`
  (`layout/geometry.ts`)は `cfg` を受け取らない。
- 実測(2026-09-07、`profile:synthetic` = tsx 経路、`keepNames` で約 3 倍水増し):
  `gen_long_12_other` 25.6 秒、`measureRepairVec` 45,189 回、`tryBendGridOn` 783 回、
  `placementBox` 1,716 万回、`realLeaderPaths` 26,719 回。n=8 は 1.19 秒・1,130 回。
  CI 経路(vitest)では 3.8〜4.6 秒で、受入条件 5 秒は達成済み。C2 は**任意の改善**。

## `vecOf()` / `measureRepairVec` の全呼び出しサイトと「候補間で何が動くか」

Round 1 の Q3 で「単一 placement を動かす全サイト」まで広げると決めたため、サイトごとの
変化範囲を列挙する(差分計算は「動いていない index の対判定を再利用する」ことなので、
何が動くかの保証が正しさの全て)。

| # | サイト | 動く placement | 動く幾何 | 差分の形 |
|---|---|---|---|---|
| S1 | `tryBendGridOn` 候補ループ(`emit_repair.ts:1839`) | `p` 1 件 | path i のみ(box 不変) | cross: 対 (i,·) / through: (i→·) のみ。(·→i) と `clips`・`ovl`・`boxPie`・`view` は候補間で**定数** |
| S2 | `tryRebendInvolved` bend 格子(`:1901`) | `p` 1 件 | 同上 | 同上 |
| S3 | 水平 pie-clear シフト(`:1945`。`p.x` + `clampPlacement`) | `p` 1 件 | path i + box i | cross: (i,·) / through: (i→·) と (·→i) / box 系 4 指標は再計算(全て軽い) |
| S4 | 複合手(`:1967`。S3 の後に `tryBendGridOn(ctx, p)` と交差相手 `j` 群の bend 替え) | `p` + 相手 `j` 群 | path {i} ∪ J、box i | 変化 index **集合**。S1 内部は自前で差分するが、`:1967` の再採点は集合差分か全走査 |
| S5 | 左 rim 再ハグ(`:1992`。`reshapeToLeftRimHug(p)`) | `p` 1 件 | path i + box i(lines / anchor も変わりうる) | S3 と同じ |
| S6 | 交差対スワップ(`trySwapCrossingPairs` `:2064`。x / y / baseline 交換) | 2 件 | path と box が 2 index | 変化 index 集合 {ia, ib} |
| S7 | 左列再積み(`tryRestackLeftColumn` `:2126`) | 左列全体 | 多数 | 差分の意味なし。全走査のまま |
| S8 | `repairResidualLeaderDefects` の iter 頭 `cur = vecOf()`(`:2167`) | 直前 iter で採用した 1 手の分 | 手による | 6 回以内。全走査のまま |
| S9 | seam 逃がしの累積プレフィックス探索(`mode_passes.ts:1883/1886`。`escapeOne(c)`) | `c` 1 件(他の `e` は読むだけ) | path c + box c | 前の候補の「後」が次の候補の「前」。基準を 1 手ずつ進める形の差分 |
| S10 | seam 逃がし greedy(`mode_passes.ts:1852` 系。採点側) | `c` 1 件 | 同上 | `countLeaderCrossings` 等の個別呼び出し(`measureRepairVec` 経由でない)。対象外か要判断 |
| S11 | パス前後の計測(`emit_repair.ts:2393/2395`) | パス全体 | 多数 | 全走査のまま |

S1 / S2 が回数の主因(格子 30 候補 × 関与 leader × 最大 6 反復)。S3〜S6 は 1 手につき
1〜数回で、差分化の効果は小さいが、同じ差分 API で扱えるなら分岐を増やさずに済む。

## 前提・仮定の棚卸し(リスク順)

| # | 仮定 | 種別 | リスク |
|---|---|---|---|
| A1 | index 対の整数差分は名前キー `Set.size` と一致する(同名スライスが無い場合に限る) | 実現性 | 高 |
| A2 | 「速くなった」を判定する計測手段がある(現行 `perfCounters` では見えない) | 検証 | 高 |
| A3 | 差分化するサイトごとに「動いていない index は本当に動いていない」を保証できる | アーキ | 中 |
| A4 | 基準ペア状態(対判定の行列)をループ内ローカルに持つことは「モジュールグローバルのメモ新設」に当たらない | 制約 | 中 |
| A5 | 差分計算と全走査の等価性を機械検証できる(現状 `replaceLeaderGeometryAt` すら未検証) | 検証 | 中 |
| A6 | C1(`gen_long_14_other` の生成器変更でハッシュ 1 行更新)と C2(バイト不変)は同時に走らせても検証が混ざらない | 依存 | 中 |
| A7 | 整数指標(cross / through / pieCross / inv / clips / oob)は差分でも FP 誤差が入らない。max 系(ovl / boxPie / view)は box 配列から同式で再計算すれば同値 | 実現性 | 低 |

## Round 1(2026-09-07)

### 質問と回答

- Q1(同名スライスと名前キー `Set` の意味論): **A** — 名前が全件一意なら index 対の整数差分、
  同名が 1 組でもあれば従来の全走査へフォールバック。C(同名を無視した整数カウント)は却下。
  ユーザーの事実認識: 「ラベル名の同一は起きえない。入力はストアドプロシージャ(DB)で整形済み」。
  これを**入力契約として記録**したうえで、コード側は契約に依存せずフォールバックで守る。
- Q2(受入条件と計測): **A** — 対判定回数の `perfCounters`(`segmentsIntersect` /
  `leaderCrossesBox` の呼出数)を足し「○割減」を完了条件にする。閾値の数字は計測してから
  Round 2 以降で決める。
- Q3(適用範囲): **B** — bend 格子 2 ループ + 単一 placement を動かす全サイト。サイトごとの
  変化範囲は上の表(S1〜S11)で列挙した。

### 挑戦した仮定

| 仮定 | 発見 | 影響 | 決定 |
|---|---|---|---|
| A1 index 差分 = `Set.size` | 同名スライスは入力で拒否されず、`Set` が重複キーを潰す。差分と `.size` が乖離しうる | 高(バイト不変を破る経路) | 名前一意のときだけ差分、同名はフォールバック。入力契約(DB 整形済み)を記録 |
| A2 計測手段 | `measureRepairVec` 回数は差分化で減らない。熱源の `segmentsIntersect` / `leaderCrossesBox` は `cfg` を受けない | 高 | 対判定回数のカウンタを足す。配線方法は Round 2 の論点 |
| 適用範囲は bend 2 ループで十分 | S3〜S9 も単一 placement の移動で、同じ差分 API で扱える | 中 | 範囲 B。S7 / S8 / S11 は全走査のまま |

### 決定事項

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| 同名スライス | 名前一意を差分の前提条件にし、同名時は全走査へフォールバック(分岐 1 つ) | 等価性が自明。入力契約(DB 整形済み)にコードは依存しない | 低 |
| 入力契約 | 「スライス名は一意」を設計正典へ記録する(検証はしない。フォールバックが守る) | ユーザーの事実認識 | 低 |
| 完了条件 | 対判定回数のカウンタで「○割減」。閾値は計測後 | トランスパイラ非依存・決定的 | 低 |
| 適用範囲 | S1〜S6・S9(単一 placement または小さな index 集合)。S7 / S8 / S11 は全走査 | 回数の主因は S1 / S2。他は同一 API で扱える範囲に限る | 中 |
| 同名フォールバックのテスト | 同名入力で差分がフォールバックし全走査と同値になることを固定するテスト 1 件 | 契約に依存しない守りを機械固定 | 低 |

### Round 2 へ持ち越した論点

- 基準ペア状態(対判定の行列)の置き場と「モジュールグローバルのメモ新設禁止」の境界。
- 差分 API の形(単一 index 専用か、変化 index 集合を受けるか)。
- 等価性の機械検証の形(`replaceLeaderGeometryAt` ≡ `collectLeaderGeometry` の単体テストを含む)。
- C1(`gen_long_14_other` のハッシュ更新)との順序。
- 対判定カウンタの配線(`cfg` を受けない `segmentsIntersect` / `leaderCrossesBox` をどう数えるか)。

## Round 2(2026-09-07)

### 質問と回答

- Q4(基準ペア状態の置き場と差分 API): **A** — `ScoreBase = { geo, crossMat, throughMat }` を
  **呼び出し側ローカル**に作り、`measureRepairVecDelta(base, placements, cfg, coord, changed: number[])`
  へ渡す。寿命は候補ループ 1 回(既存 `base` と同形)。`changed.length >= n` なら内部で全走査に
  落ちる。`ResidualRepairCtx` には載せない。`LeaderGeometry` に行列を同居させる案(C)は、幾何
  だけ欲しい `collectDefectInvolved` 等でも O(n²) 対判定が走るため却下。
- Q5(等価性の機械検証): **A** — 3 段。①seeded 自前 LCG で placements を生成し bend / x / y を
  1〜2 件動かして、`replaceLeaderGeometryAt(collect(P), i)` ≡ `collect(P')` と
  `measureRepairVecDelta` ≡ `measureRepairVecFrom`(全走査)を **全 9 フィールド deep-equal** で
  固定する property 風テスト(fast-check はオフライン重量物バンドルの再生成を伴うので使わない)。
  ②同名入力で差分がフォールバックし全走査と同値になることを固定するテスト 1 件。
  ③既存の `batch:diff`(83 件)と `render_hash` 定数表 26 行不変。
- Q6(C1 との順序): **A** — **C1 → C2**。C2 のバイト不変検証の基準は C1 後の定数表
  (`renderHashExpected.ts` 26 行が 1 行も動かない)。`gen_long_14_other` は C1 で別入力になり、
  C2 の計測ケースが n=12 / n=14 の 2 件になる。
- Q7(対判定カウンタの配線): **A** — 数えるのは `crossingPairsFrom` / `throughPairsFrom`
  (とその差分版)で、1 対の判定につき `perfCounters.pairTests += 1`。`...From` 系関数に `cfg` を
  1 引数足す。`layout/geometry.ts` の純関数(`segmentsIntersect` / `leaderCrossesBox`)は触らず、
  モジュールスコープのカウンタ変数(B)は禁止事項に近い形なので却下。

### 挑戦した仮定

| 仮定 | 発見 | 影響 | 決定 |
|---|---|---|---|
| A4 ローカルな基準状態はメモ新設に当たらない | 既存の `base`(`collectLeaderGeometry` の結果)と同じ寿命・同じ置き場なら、2.3 節が禁じる「モジュールグローバル」にも「描画をまたぐメモ」にも当たらない | 中 | `ScoreBase` は呼び出し側ローカル・引数渡し |
| A5 等価性は byte-diff で足りる | `replaceLeaderGeometryAt` すら単体テストが無い。差分は「動いていない index の再利用」なので、実サンプルに無い動かし方で壊れても byte-diff は検出できない | 中 | property 風 deep-equal を置く |
| A6 C1 と並行できる | 両方が `renderHashExpected.ts` / `test/helpers` に触る | 中 | C1 → C2 の直列 |
| A2 カウンタは熱源関数に置く | 熱源は `cfg` を受けない純関数。呼び出し側で 1 対 +1 すれば計算量の指標としては十分 | 低 | `pairTests` は `...PairsFrom` 系で数える |

### 決定事項

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| 差分 API | `measureRepairVecDelta(base, placements, cfg, coord, changed)`。行列は cross / through の 2 つだけ。他 7 指標は `geo` から全件再計算(軽い) | 重いのは対判定 2 種のみ | 低 |
| 基準状態の置き場 | 呼び出し側ローカル(候補ループ 1 回の寿命)。`ctx` / モジュールに持たない | 2.3 節との整合 | 低 |
| 等価性の検証 | seeded LCG の property 風 deep-equal + 同名フォールバック固定 + 既存 byte/hash 網 | 差分は実サンプルに無い動かし方で壊れうる | 低 |
| C1 との順序 | C1 → C2 | 検証の基準表を 1 つにする | 低 |
| カウンタ | `perfCounters.pairTests`(1 対 +1)。`...From` 系に `cfg` を 1 引数足す | トランスパイラ非依存・純関数を触らない | 低 |

## Round 3(2026-09-07)

### 確定した事項(問いを要しないもの)

**(1) 閾値の決め方 — 計測手順と書く場所。**

- 計測手順(C1 完了後の tree で行う):
  1. `pairTests` カウンタを**先に単独コミット**する(差分化より前。基準値を同じ計数規則で取るため)。
  2. `npm run profile:synthetic gen_long_12_other` / `gen_long_14_other` を回し、`pairTests` の
     基準値を spec に写す(`seconds` は `keepNames` で水増しされるため参考値、比較は回数で行う)。
  3. 差分化の後に同じ 2 ケースを回し、削減率を spec の受入条件へ書く。
- 理論値(spec で説明する根拠): 全走査の採点 1 回は cross `n(n-1)/2` + through `n(n-1)` =
  `1.5·n(n-1)` 対。差分(`changed` = 1 index)は cross `(n-1)` + through `2(n-1)`(i→· と ·→i)=
  `3(n-1)` 対。比は `n/2` で、n=12 なら 1 回あたり 6 分の 1、n=14 なら 7 分の 1。回数の主因
  S1 / S2 がこの比で減り、S7 / S8 / S11 の全走査は 1 チャートあたり十数回なので、全体の
  削減率はこの比に近づく。受入の数字は実測で決めるが、理論値を下回る削減率なら実装の
  取りこぼし(全走査へのフォールバックが意図せず効いている等)とみなす。
- 書く場所: spec(`docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md`)の
  「受入条件」節に、基準値・実測値・削減率・理論値の 4 つを表で置く。閾値の数字は
  この dig では**決めない**。

**(3) 完了条件の最終形と 2.3 節の照合。**

- 完了条件:
  1. `npm run batch` → `batch:diff` で実サンプル 83 件が byte 一致。
  2. `render_hash` 定数表 26 行(C1 後)・`final_score` / `mark_flags` の `.snap` が不変。
  3. property 風 deep-equal(`replaceLeaderGeometryAt` / `measureRepairVecDelta`)と同名
     フォールバック固定テストが緑。
  4. `pairTests` が `gen_long_12_other` / `gen_long_14_other` の両方で spec に書いた削減率以上。
  5. `typecheck:pie-chart`・`check:comments`・biome・coverage(既存 include の閾値)が緑。
- 2.3 節(してはならないこと)との照合:

  | 禁止事項 | C2 での扱い |
  |---|---|
  | `iterateOverlapPairs` の巻き上げ | 触らない(`post_layout.ts`。差分の対象外) |
  | モジュールグローバルのメモ新設 | `ScoreBase` は呼び出し側ローカル。カウンタは既存の `cfg.perfCounters` 経由 |
  | `{ ...cfg, textColor }` の cfg コピーを extent 系へ渡す経路 | 作らない。`...From` 系へ足す `cfg` 引数は呼び出し側の同じ参照をそのまま渡す |
  | 早期打ち切り | 採らない。差分は同じ値を返すだけで、候補ループの `if (better) return true` は既存の挙動 |
  | `EMIT_REPAIR_PASSES` の順序・stage | 触らない |

### 質問と回答

- Q8(S9 = seam 累積プレフィックス探索の扱い): **A** — **全走査のまま残す**。`advanceScoreBase`
  (採用した手の差分を base へ書き戻す関数)は作らない。根拠: `thorough=true` は emit 最終段のみ、
  `explorePrefix` は最大 2 回 × 候補 ≤ n なので 1 チャートあたり ≤ 2(n+1) 回(n=12 で 26 回。
  全体 45,189 回の 0.06%)。効果が測定誤差以下のサイトのために「前進した base が現在の
  placements と一致している」保証を `seamRestore(snap0)` / `bestSnap` の巻き戻しと絡めて
  検証する価値が無い。**Round 1 Q3-B「単一 placement を動かす全サイト」の字面との差**は
  この理由による意図的な除外で、適用範囲は「S1〜S6 = `ScoreBase` を候補ループの中で使い切る形」
  に閉じる。S10(seam greedy。`measureRepairVec` 経由でない個別呼び出し)も同じ理由で対象外。
- Q9(`changed[]` の意味論): **A** — **保守的**。`changed` の index は「path も box も変わりうる」と
  みなし、cross (i,·) と through (i→·)・(·→i) を全部再判定する。S1 / S2 でも同じ。「box は bend を
  読まない」不変則に差分の正しさを依存させない(呼び出し側が「box は動いていない」を自己申告する
  細分化案 B は、申告を誤るとバイト不変を静かに破るので却下)。理論比は n/2(n=12 で 6 分の 1、
  n=14 で 7 分の 1)。削減率が不足したときも B へは進まず、別の手段を検討する。

### 挑戦した仮定

| 仮定 | 発見 | 影響 | 決定 |
|---|---|---|---|
| 適用範囲 B は全サイトを差分化する | S9 は 1 チャート ≤ 2(n+1) 回で効果が無く、基準の前進 API は検証項目だけ増やす | 低 | S9 / S10 は全走査のまま(理由を記録) |
| S1 / S2 では box が不変(through の ·→i を再利用できる) | 「box は bend を読まない」という別の不変則への依存。差分の正しさを不変則に預ける形になる | 中(バイト不変を静かに破る経路) | `changed` は保守的に読む。理論比 n/2 を受け入れる |

### 決定事項

| 論点 | 決定 | 根拠 | リスク |
|---|---|---|---|
| S9 / S10 | 全走査のまま。`advanceScoreBase` は作らない | 回数が全体の 0.06% | 低 |
| `changed[]` の意味論 | 保守的(path も box も変わりうる)。API 1 種類・等価性テストの前提 1 つ | 不変則への依存を作らない | 低 |
| 閾値の決め方 | 計測手順(カウンタ先行コミット → 基準値 → 差分化 → 実測)と理論値 n/2 を確定。数字は spec の受入条件節へ | 本節 (1) | 低 |
| 完了条件 | 本節 (3) の 5 項目 | — | 低 |

## Phase 5: 完了判定

| 項目 | 判定 | 根拠 |
|---|---|---|
| HIGH の仮定(A1 同名スライス / A2 計測手段)が決定済み | ✔ | Q1(名前一意のときだけ差分・同名はフォールバック・入力契約を記録)/ Q2 + Q7(`perfCounters.pairTests`) |
| MED の仮定(A3 サイトごとの不変保証 / A4 メモ新設の境界 / A5 等価性検証 / A6 C1 との順序)が決定済み | ✔ | S1〜S11 の表 + Q3 / Q8 / Q9(範囲と `changed` の意味論)/ Q4(呼び出し側ローカル)/ Q5(3 段の検証)/ Q6(C1 → C2) |
| LOW の仮定(A7 FP 不変)が確認済み | ✔ | 整数指標は差分でも exact。max 系 3 指標と `inv` は `geo` から同式で全件再計算(差分しない) |
| 各主題で 2 段以上掘った | ✔ | 同名 → フォールバック → 固定テスト / 計測 → カウンタ配線 → 手順と理論値 / 範囲 → サイト列挙 → S9 除外と `changed` 意味論 / 基準状態 → 置き場 → API 形 |
| 未回収の「新たに浮かんだ問い」が無い | ✔ | Round 2 持ち越し 5 件と Round 3 の 2 件を全て回収 |
| トレードオフを明示した | ✔ | Q9(保守的 = 候補 1 回あたり (n-1) 対の余分 vs 不変則への非依存)/ Q8(字面の適用範囲 vs 検証負荷)/ Q5(乱数 placements の代表性 vs 分布非依存の性質) |
| 失敗モードを議論した | ✔ | 同名入力(フォールバック)/ 削減率が理論値を下回る(取りこぼしの兆候)/ `changed` の申告誤り(保守的読みで構造的に排除)/ C1 と検証基準の交錯(直列化) |
| 禁止事項 2.3 節との照合表がある | ✔ | Round 3 (3) の表(5 項目すべて「触らない / ローカル / 既存経由」) |
| 受入条件の置き場と計測手順が確定 | ✔ | Round 3 (1)。spec の「受入条件」節に基準値・実測値・削減率・理論値の表 |
| C1 → C2 の順序が確定 | ✔ | Q6。C2 の基準は C1 後の `renderHashExpected.ts` 26 行 |

## Dig Summary

### 概要

- Round: 3 / 質問: 9(Q1〜Q9)/ 挑戦した仮定: 7(A1〜A7)+ Round 中に浮かんだ 3 / 決定: 14

### 主な発見

1. `cross` / `through` は名前キー `Set.size` で、同名スライスは入力で拒否されない。index 対の
   整数差分がバイト不変を破る唯一の経路はここで、名前一意を条件にしたフォールバックで塞ぐ。
2. 重いのは対判定 2 種だけ。他 7 指標は差分にせず `geo` から全件再計算すれば、行列は
   cross / through の 2 つで済み、max 系の FP 順序問題も生じない。
3. 差分の正しさは「動いていない index は本当に動いていない」に尽きる。S1〜S11 の列挙で
   回数の主因が S1 / S2 だと分かり、`changed` を保守的に読んでも理論比 n/2 が残る。
4. 現行 `perfCounters` では効果が見えない。`pairTests` をカウンタ先行コミットで足し、同じ
   計数規則で基準値と実測値を取る。

### 全決定(1 行要約)

| # | 論点 | 決定 |
|---|---|---|
| Q1 | 同名スライス | 名前一意なら index 差分、同名 1 組でも全走査へフォールバック。入力契約「名前は一意(DB 整形済み)」を記録し、コードは契約に依存しない |
| Q2 | 完了条件の指標 | `perfCounters.pairTests` の「○割減」。数字は計測後に spec へ |
| Q3 | 適用範囲 | bend 格子 2 ループ + 単一 placement を動かすサイト(S1〜S6)。S7 / S8 / S11 は全走査 |
| Q4 | 基準状態と API | 呼び出し側ローカルの `ScoreBase { geo, crossMat, throughMat }` + `measureRepairVecDelta(base, placements, cfg, coord, changed[])`。`changed.length >= n` は内部で全走査 |
| Q5 | 等価性の検証 | seeded LCG の property 風 deep-equal(`replaceLeaderGeometryAt` / `measureRepairVecDelta`)+ 同名フォールバック固定テスト + 既存 `batch:diff` / `render_hash` 26 行不変 |
| Q6 | C1 との順序 | C1 → C2。基準は C1 後の定数表 |
| Q7 | カウンタの配線 | `...PairsFrom` 系で 1 対 +1、`cfg` を 1 引数足す。純関数は触らない |
| Q8 | S9(seam 累積探索) | 全走査のまま。`advanceScoreBase` は作らない(回数 0.06%) |
| Q9 | `changed[]` の意味論 | 保守的(path も box も変わりうる)。理論比 n/2。細分化案は却下 |

### 残るリスク

- 削減率の数字は未計測(手順は確定)。理論値 n/2 を下回れば実装の取りこぼしとして扱う。
- 乱数 placements の等価性テストは実配置の分布を代表しない可能性があるが、等価性は分布に
  よらず成り立つべき性質で、実配置側は既存の byte / hash 網が受ける。
- 同名スライスの入力契約は検証しない(フォールバックが守る)。契約が破られても出力は不変。

### 次工程

未決事項なし。brainstorming → spec(`docs/superpowers/specs/2026-09-07-pie-chart-diff-scoring-design.md`)
→ writing-plans。C1 の完了を待ってから C2 の計測(基準値)に入る。
