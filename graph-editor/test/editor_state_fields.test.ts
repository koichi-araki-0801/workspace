// =============================================================================
// editor_state_fields.test.ts — 編集状態の等値判定 (`stateEquals`) の単体テスト
// =============================================================================
// `utils.js` は DOM API を**関数の中でしか**触らないので、node からそのまま import して
// 純粋な部分 (`STATE_FIELDS` / `stateEquals`) を検証できる (`editor_svg_policy.test.ts` と
// 同じ流儀。jsdom は入れない)。
//
// 「編集済みか」の判定はドラッグ中の毎フレーム・全ラベル分走る経路なので、
// `JSON.stringify` 2 回の比較からフィールドごとの等値判定へ置き換えた。本ファイルは
// **置き換えで判定結果が変わっていないこと**を、旧実装 (直列化比較) との一致で主張する。

import { describe, expect, it } from "vitest";
import { STATE_FIELDS, stateEquals } from "../resources/web/js/utils.js";

/** `LabelState.snapshot()` 相当 (`STATE_FIELDS` の `copy` を通した複製)。 */
function snapshot(state: any) {
  const snap: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(STATE_FIELDS as Record<string, any>)) snap[k] = f.copy(state[k]);
  return snap;
}

/** 旧実装の判定 (置き換え前の `isLabelEdited` そのもの)。 */
function legacyEquals(a: any, b: any) {
  return JSON.stringify(snapshot(a)) === JSON.stringify(b);
}

function baseState() {
  return {
    textTx: { x: 0, y: 0 },
    leaderPts: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    leaderVisible: true,
    fill: "#111111",
    lineCount: 1,
    nameScaleX: 1,
    _auto: false,
  };
}

/** 1 フィールドだけ差し替えた状態を作る。 */
function mutate(patch: Record<string, unknown>) {
  return { ...baseState(), ...patch };
}

const VARIANTS: Array<[string, any]> = [
  ["無変更", baseState()],
  ["textTx.x", mutate({ textTx: { x: 1, y: 0 } })],
  ["textTx.y", mutate({ textTx: { x: 0, y: -0.5 } })],
  ["leaderPts の座標", mutate({ leaderPts: [{ x: 1, y: 2 }, { x: 3, y: 5 }] })],
  ["leaderPts の点数 (増)", mutate({ leaderPts: [{ x: 1, y: 2 }, { x: 9, y: 9 }, { x: 3, y: 4 }] })],
  ["leaderPts の点数 (減)", mutate({ leaderPts: [{ x: 1, y: 2 }] })],
  ["leaderPts が空", mutate({ leaderPts: [] })],
  ["leaderVisible", mutate({ leaderVisible: false })],
  ["fill", mutate({ fill: "#ffffff" })],
  ["lineCount", mutate({ lineCount: 2 })],
  ["nameScaleX", mutate({ nameScaleX: 0.85 })],
  ["_auto (自動 leader か)", mutate({ _auto: true })],
];

describe("stateEquals", () => {
  it("初期スナップショットとの比較結果が旧実装 (直列化比較) と一致する", () => {
    const initial = snapshot(baseState());
    for (const [label, state] of VARIANTS) {
      expect(stateEquals(state, initial), label).toBe(legacyEquals(state, initial));
    }
  });

  it("等しい状態は等しい / 1 フィールドでも違えば等しくない", () => {
    const initial = snapshot(baseState());
    expect(stateEquals(baseState(), initial)).toBe(true);
    // 複製 (`copy`) を挟んでも同値のままであること (参照比較へ退化していない)。
    expect(stateEquals(snapshot(baseState()), initial)).toBe(true);
    for (const [label, state] of VARIANTS.slice(1)) {
      expect(stateEquals(state, initial), label).toBe(false);
    }
  });

  it("片方が欠けていれば等しくないと判定する (未読込との取り違え防止)", () => {
    expect(stateEquals(baseState(), null)).toBe(false);
    expect(stateEquals(null, snapshot(baseState()))).toBe(false);
    expect(stateEquals(null, null)).toBe(false);
  });

  it("`fill` の未設定 (null) 同士は等しく、片側だけ null なら等しくない", () => {
    // `fill` は `originalFill=null` の `<text>` がありうる (`label-state.js`)。
    const a = mutate({ fill: null });
    const b = mutate({ fill: null });
    expect(stateEquals(a, snapshot(b))).toBe(true);
    expect(stateEquals(a, snapshot(baseState()))).toBe(false);
    expect(stateEquals(baseState(), snapshot(a))).toBe(false);
  });

  it("_auto は STATE_FIELDS に含まれ、snapshot/apply で往復する", () => {
    expect(Object.keys(STATE_FIELDS)).toContain("_auto");
    const snap = snapshot(mutate({ _auto: true }));
    expect(snap._auto).toBe(true);
    expect(stateEquals(mutate({ _auto: true }), snapshot(baseState()))).toBe(false);
  });

  it("全フィールドに等値判定がある (項目追加時の付け忘れを落とす)", () => {
    for (const [k, f] of Object.entries(STATE_FIELDS as Record<string, any>)) {
      expect(typeof f.copy, k).toBe("function");
      expect(typeof f.equals, k).toBe("function");
    }
  });
});
