// =============================================================================
// editor_label_text.test.ts — ラベル表示文字列の取り出し (`extractPercentText`) の単体テスト
// =============================================================================
// `utils.js` は DOM API を関数の中でしか触らないので node からそのまま import できる
// (`editor_state_fields.test.ts` と同じ流儀。jsdom は入れない)。
//
// 本ファイルが守るのは「画面に出ている数値が編集操作で別物へ書き換わらないこと」。
// 生成側の `data-percent` は総和比の絶対値で、表示文字列 (符号付きの `△0.8%`、丸めの結果
// 総和が 100 を超える `100.8%`) とは一致しない。行数や長体を変えると `rebuildTextContent`
// が `tspan` を組み直すため、そこで `data-percent` から作り直すと数値が変わってしまう。

import { describe, expect, it } from "vitest";
import { extractPercentText } from "../resources/web/js/utils.js";

/** `<text>` 直下の `tspan` 記述子 (`hasX` = 行頭かどうか)。 */
type Tspan = { hasX: boolean; text: string };

/** `label-state.js` の `rebuildTextContent` が組む `tspan` 構成を記述子で再現する。
 *  2 行構成は名前行と % 行がそれぞれ `x` を持ち、1 行構成は % を同一チャンクへ流し込む。
 *  `longBody` (長体) は名前行の内側へ `x` なしの `tspan` を 1 枚挟む。 */
function rebuilt(name: string, percentText: string, two: boolean, longBody = false): Tspan[] {
  const rows: Tspan[] = [{ hasX: true, text: longBody && two ? "" : name }];
  if (longBody && two) rows.push({ hasX: false, text: name });
  rows.push(two ? { hasX: true, text: percentText } : { hasX: false, text: ` ${percentText}` });
  return rows;
}

describe("extractPercentText", () => {
  it("2 行構成では % 行の表示文字列をそのまま採り、data-percent から作り直さない", () => {
    // 実サンプル (pdf_510037_06_gold_asset.svg): 表示は 100.8% / △0.8% で data-percent と乖離する。
    expect(extractPercentText(
      [{ hasX: true, text: "外国投資信託証券" }, { hasX: true, text: "100.8%" }],
      "外国投資信託証券", "99.2",
    )).toBe("100.8%");
    expect(extractPercentText(
      [{ hasX: true, text: "その他" }, { hasX: true, text: "△0.8%" }],
      "その他", "0.8",
    )).toBe("△0.8%");
  });

  it("1 行構成では名前の分だけを落として % 部分を採る", () => {
    // 生成側の 1 行ラベルは名前と % を 1 枚の `tspan` へまとめて出す。
    expect(extractPercentText([{ hasX: true, text: "その他 4.0%" }], "その他", "4.0")).toBe("4.0%");
    // 編集後 (`rebuildTextContent` の 1 行構成) も同じ結果になる。
    expect(extractPercentText(rebuilt("その他", "4.0%", false), "その他", "4.0")).toBe("4.0%");
  });

  it("行数 1 と 2 を往復しても表示文字列が変わらない", () => {
    const name = "外国投資信託証券";
    const source: Tspan[] = [{ hasX: true, text: name }, { hasX: true, text: "100.8%" }];
    let pct = extractPercentText(source, name, "99.2");
    for (const [two, longBody] of [[false, false], [true, false], [true, true], [false, false]] as const) {
      pct = extractPercentText(rebuilt(name, pct, two, longBody), name, "99.2");
      expect(pct).toBe("100.8%");
    }
  });

  it("% が表示されていないラベルは空文字 (data-percent があっても足さない)", () => {
    // 引出線なし・円内のラベルは名前だけを出すことがある。ここで `50%` を生やすと、
    // 行数を変えただけで画面に無かった数値が現れる。
    expect(extractPercentText([{ hasX: true, text: "Beta" }], "Beta", "50")).toBe("");
  });

  it("表示文字列から読み取れないときだけ data-percent を保険に使う", () => {
    // `data-name` と表示テキストが食い違う SVG (生成側以外の入力) 向けの退避経路。
    expect(extractPercentText([{ hasX: true, text: "Gamma 12%" }], "Delta", "12")).toBe("12%");
    expect(extractPercentText([], "Delta", "12")).toBe("12%");
    expect(extractPercentText([], "Delta", null)).toBe("");
    expect(extractPercentText([], "Delta", "")).toBe("");
  });
});
