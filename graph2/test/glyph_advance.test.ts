import { describe, expect, it } from "vitest";
import { GLYPH_ADVANCE_EM } from "../src/glyph_advance.js";

describe("GLYPH_ADVANCE_EM", () => {
  it("非空の codepoint→em テーブルである", () => {
    expect(GLYPH_ADVANCE_EM.size).toBeGreaterThan(0);
  });

  it("既知の ASCII グリフ幅を返す", () => {
    // 数字 '0' (0x30) は等幅で 0.7598em (BIZ UDPGothic Bold)
    expect(GLYPH_ADVANCE_EM.get(0x30)).toBeCloseTo(0.7598);
    // 半角スペース (0x20)
    expect(GLYPH_ADVANCE_EM.get(0x20)).toBeCloseTo(0.3335);
  });

  it("全ての値は非負の有限 em (ゼロ幅グリフを含む)", () => {
    for (const [cp, em] of GLYPH_ADVANCE_EM) {
      expect(Number.isInteger(cp)).toBe(true);
      expect(em).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(em)).toBe(true);
    }
  });

  it("未収録 codepoint は undefined", () => {
    // 漢字はテーブル非収録 (実測一律 1.0 のため呼び出し側で既定化)
    expect(GLYPH_ADVANCE_EM.get(0x6f22)).toBeUndefined();
  });
});
