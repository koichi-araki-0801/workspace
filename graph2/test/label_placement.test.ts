import { describe, expect, it } from "vitest";
import { createPieLayoutConfig } from "../src/config.js";
import { leaderPath } from "../src/label_placement.js";
import type { Scale } from "../src/types.js";

const cfg = createPieLayoutConfig();
// 論理→ピクセルの単純な恒等寄りスケール (テスト用)。
const xScale: Scale = (v) => 100 + v * 50;
const yScale: Scale = (v) => 100 - v * 50;

describe("leaderPath", () => {
  it("点列を M/L コマンドの SVG path 要素に変換する", () => {
    const svg = leaderPath(xScale, yScale, [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ], cfg);
    expect(svg).toContain("<path");
    expect(svg).toContain('fill="none"');
    expect(svg).toContain(`stroke="${cfg.lineColor}"`);
    // 1 点目は M、以降は L
    expect(svg).toMatch(/d="M100,100 L150,50"/);
  });

  it("stroke-width に leaderStrokeUnits を反映する", () => {
    const svg = leaderPath(xScale, yScale, [{ x: 0, y: 0 }], cfg);
    expect(svg).toContain(`stroke-width="${cfg.leaderStrokeUnits}"`);
  });
});
