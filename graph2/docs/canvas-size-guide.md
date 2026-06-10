# キャンバスサイズ／縦横比の変更ガイド

graph2 の SVG 出力のサイズ・縦横比を変えたいときに「どこを触ればよいか」をまとめたリファレンス。
（このドキュメントは挙動を変えるものではなく、変更手順の説明です。）

---

## 1. TL;DR

キャンバスのサイズ・縦横比を変えるなら、基本は **`src/config.ts` の 3 つの値だけ**でよい。

| 目的 | 触る値 |
| --- | --- |
| 縦横比を変える | `svgWidthPx` と `svgHeightPx` の比を変える |
| 全体を拡大・縮小（比は維持） | `svgWidthPx` と `svgHeightPx` を同じ倍率で |
| 円（pie）を相対的に大きく/小さく | `pieHeightRatio` を変える |

他の寸法（円の直径・半径・中心座標・マージン・ラベル可動域・viewBox・SVG 出力サイズ）は
**すべてこの 3 値から自動で派生する**ので、手で書き換える必要はない。

> `config.ts` を直接書き換えたくない場合は、`createPieLayoutConfig({ svgWidthPx, svgHeightPx, pieHeightRatio })`
> に overrides を渡しても同じ（後述）。

---

## 2. 主要ノブ — `src/config.ts` の `base` オブジェクト

| 値 | 行 | 既定 | 意味 |
| --- | --- | --- | --- |
| `svgWidthPx`     | 24 | `600` | キャンバス幅 (px)。`1 viewBox unit = 1px` 固定。 |
| `svgHeightPx`    | 25 | `450` | キャンバス高さ (px)。 |
| `pieHeightRatio` | 28 | `0.7` | pie 直径が `svgHeightPx` に占める割合（= 半径は高さ半分の 70%）。縦横比・円の視覚的大きさを決める。 |

参考: `pieRadius`（27 行, `1.0`）は論理座標系の正規化半径で、寸法の単位系の基準。通常いじらない。

```ts
// src/config.ts (24-28行)
svgWidthPx: 600,
svgHeightPx: 450,

pieRadius: 1.0,
pieHeightRatio: 0.7,
```

---

## 3. 自動派生チェーン（編集不要・すべて `config.ts` の getter）

```
svgWidthPx ┐
svgHeightPx ┤
pieHeightRatio ┘
      │
      ├─ pieDiameterPx = pieHeightRatio × svgHeightPx        (128-138行)
      │       └─ pieRadiusPx = pieDiameterPx / 2             (139-140行)
      │               └─ pxPerUnit = pieRadiusPx / pieRadius (142-143行)  ← 論理↔px の換算係数
      │
      ├─ marginCapPx = (svgHeightPx − pieDiameterPx) / 2     (118-120行)  ← 上下余白
      │       └─ marginCapHorizontalPx = marginCapPx         (122-126行)  ← ラベル端マージン(横も縦と一様)
      │
      ├─ canvasYlim = ±svgHeightPx/2 / pxPerUnit             (153-155行)  ← ラベル縦可動域
      ├─ canvasXlim = (svgWidthPx/2 − marginCapHorizontalPx) / pxPerUnit  (157-165行)  ← ラベル横可動域
      │
      └─ fixedSvgWidth/HeightUnits・…Mm                      (203-214行)  ← 出力サイズ

座標系 createCoordinateSystem()  ── src/svg_export/rendering.ts
      幅・高さから unitScale と中央オフセットを計算
      → pie 中心 cx = xScale(0), cy = yScale(0)、半径 pieR も自動
        （src/svg_export/index.ts 内で算出）

SVG 出力  ── src/svg_export/index.ts:1533
      <svg viewBox="0 0 ${width} ${height}"
           width="${cfg.svgWidthPx}px" height="${cfg.svgHeightPx}px" …>
      背景 <rect width="${width}" height="${height}" …>   (1535行)
```

pie は常にキャンバス中央に置かれる（`xScale(x) = svgWidthPx/2 + x·unitScale`）。
そのため「円の視覚的な左右余白」は `(svgWidthPx − 直径)/2` として中央配置＋半径から自動で決まり、
個別に設定する箇所はない。

---

## 4. config.ts を直接編集しない方法（overrides）

```ts
// src/config.ts:19
export function createPieLayoutConfig(overrides: Partial<PieLayoutConfig> = {}) { … }
```

呼び出し側（実体は `src/svg_export/index.ts:1306` の `createPieLayoutConfig(options)`）に
`{ svgWidthPx, svgHeightPx, pieHeightRatio }` を渡せば、base 値を差し替えられる。
一時的な出力サイズ違いや A/B 比較はこちらが安全。

---

## 5. ガード条件（変更が無効な範囲だと throw する）

- **直径 > 幅**: `pieDiameterPx = pieHeightRatio × svgHeightPx` が `svgWidthPx` を超えると例外。
  → 縦長キャンバス（`svgHeightPx` が大きく `svgWidthPx` が小さい）で `pieHeightRatio` を上げすぎると発生。
- **fontSize 過大**: `canvasXlim` の half-width が `svgWidthPx/2 − marginCapHorizontalPx ≤ 0` になると例外。
  → 幅を縮めたのに `fontSize` が大きいままだと発生（マージンが幅を食い潰す）。

---

## 6. 変更後チェックリスト（自動だが挙動が変わる箇所）

寸法・縦横比を変えると、派生で自動追従はするが**配置ロジックの挙動が変わる**ため、要回帰確認:

- [ ] **leftStackMode** — `src/layout.ts:1264` 付近、`viewBoxLeft = −svgWidthPx/2 / pxPerUnit`。
      幅変更で左ラベルの 2 行化境界が動く。
- [ ] **dominant outside-edge 判定** — `src/svg_export/index.ts:152` 付近。
      canvasXlim でなく実 `svgWidthPx` 基準なので、幅変更で 1 強ラベルの rim 配置が変わる。
- [ ] **横方向ラベル spread** — `src/layout.ts` の X スケール群。縦横比でラベルの左右広がりが変わる。
- [ ] **fontSize の崖**（既知）— 26→warn0 / 27→3 / 28→7。
      キャンバスを縮めると同じ `fontSize` でも見切れ警告が増えうる。
      `labelRadius`/`minGap` を単独で動かしても効きにくく、寸法・fontSize 連動の
      `gapScale` / `geometryScale` / `radialFraction()` 経由で効く点に注意。
- [ ] **全件チェックを必ず実行**（単一サンプル確認で済ませない）:
      ```
      node test_batch.js
      node verify_svg.js
      ```
      verify は実 viewBox を読んで見切れ・leader 交差を検出するので、寸法変更後も整合する。

### 参考: 直接の寸法依存ではないが関連する箇所
- `verify_svg.ts` の自前定数（`CHAR_WIDTH_FACTOR=1.0` 等）は `config.ts` と一致必須で、起動時にドリフト検出される。キャンバス寸法そのものではないが、フォント幅モデルを変えるならここも揃える。
- `test_batch.ts` の A4 プレビュー（210mm 固定、aspect-ratio は config から算出）は表示用のみ。出力 SVG 自体には影響しない。
