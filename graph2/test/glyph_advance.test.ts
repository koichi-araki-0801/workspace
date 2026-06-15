import { describe, expect, it } from "vitest";
import { GLYPH_ADVANCE_BY_WEIGHT } from "../src/glyph_advance.js";

describe("GLYPH_ADVANCE_BY_WEIGHT", () => {
  it("400/700 の非空テーブルを持つ", () => {
    expect(GLYPH_ADVANCE_BY_WEIGHT["400"].size).toBeGreaterThan(0);
    expect(GLYPH_ADVANCE_BY_WEIGHT["700"].size).toBeGreaterThan(0);
  });

  it("既知の ASCII グリフ幅を返す (BIZ UDPGothic)", () => {
    // 数字 '0' (0x30) は等幅で 0.7598em (400/700 同値)
    expect(GLYPH_ADVANCE_BY_WEIGHT["400"].get(0x30)).toBeCloseTo(0.7598);
    expect(GLYPH_ADVANCE_BY_WEIGHT["700"].get(0x30)).toBeCloseTo(0.7598);
    // 半角スペース (0x20)
    expect(GLYPH_ADVANCE_BY_WEIGHT["400"].get(0x20)).toBeCloseTo(0.3335);
  });

  it("プロポーショナルなグリフはウェイトで advance が異なる", () => {
    // '.' (0x2e): Regular 0.3101 / Bold 0.3301
    expect(GLYPH_ADVANCE_BY_WEIGHT["400"].get(0x2e)).toBeCloseTo(0.3101);
    expect(GLYPH_ADVANCE_BY_WEIGHT["700"].get(0x2e)).toBeCloseTo(0.3301);
    // 'ア' (0x30a2): Regular 0.8901 / Bold 0.9102
    expect(GLYPH_ADVANCE_BY_WEIGHT["400"].get(0x30a2)).toBeCloseTo(0.8901);
    expect(GLYPH_ADVANCE_BY_WEIGHT["700"].get(0x30a2)).toBeCloseTo(0.9102);
  });

  it("全ての値は非負の有限 em (ゼロ幅グリフを含む)", () => {
    for (const table of Object.values(GLYPH_ADVANCE_BY_WEIGHT)) {
      for (const [cp, em] of table) {
        expect(Number.isInteger(cp)).toBe(true);
        expect(em).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(em)).toBe(true);
      }
    }
  });

  it("未収録 codepoint は undefined", () => {
    // 漢字はテーブル非収録 (実測一律 1.0 のため呼び出し側で既定化)
    expect(GLYPH_ADVANCE_BY_WEIGHT["400"].get(0x6f22)).toBeUndefined();
    expect(GLYPH_ADVANCE_BY_WEIGHT["700"].get(0x6f22)).toBeUndefined();
  });
});
