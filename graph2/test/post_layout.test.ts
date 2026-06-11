// relaxNameCondense の単体テスト。長体 (nameScaleX < 1) になったラベルが
// 「キャンバス・pie・隣接ラベルに当たらない範囲で原寸 (sx=1) へ向けて戻る」ことを検証する。
import { describe, expect, it } from "vitest";

import { createPieLayoutConfig } from "../src/config.js";
import { relaxNameCondense } from "../src/svg_export/post_layout.js";
import { placementBox, scaledLabelWidthUnits, radialFraction } from "../src/svg_geom.js";
import type { Placement, PieLayoutConfig } from "../src/types.js";

const cfg = createPieLayoutConfig();

function makePlacement(over: Partial<Placement> = {}): Placement {
  return {
    x: 0,
    y: 0,
    anchor: "start",
    baseline: "middle",
    lines: ["ながいなまえ", "10.0%"],
    item: { name: "ながいなまえ", value: 1, percentText: "10.0%" },
    leaderAnchor: { x: 0, y: 0 },
    leaderBend: { x: 0, y: 0 },
    leaderEndpoint: { x: 0, y: 0 },
    leaderBendFollowsEndpointY: false,
    leaderBendFollowsEndpointX: false,
    origTextX: 0,
    origTextY: 0,
    upperLeftHairpinCheck: false,
    skipLeader: false,
    insideSlice: false,
    nameScaleX: 0.7,
    ...over,
  };
}

/** 2 行ラベルの幅 (nameScaleX 込み)。期待値計算用に実装と同じ幅モデルを使う。 */
function widthAt(p: Placement, sx: number, c: PieLayoutConfig): number {
  const lineCount = p.lines.length >= 2 ? 2 : 1;
  return scaledLabelWidthUnits(p.item.name, p.item.percentText ?? "", lineCount, sx, c);
}

function distToPie(b: { left: number; right: number; top: number; bottom: number }): number {
  const nx = Math.max(b.left, Math.min(0, b.right));
  const ny = Math.max(b.bottom, Math.min(0, b.top));
  return Math.hypot(nx, ny);
}

describe("relaxNameCondense", () => {
  it("余裕があれば原寸 (sx=1) まで戻る", () => {
    const p = makePlacement({ x: cfg.canvasXlim[0], y: 1.25 });
    relaxNameCondense([p], cfg);
    expect(p.nameScaleX).toBe(1);
  });

  it("canvasXlim 超過直前の最大格子値で止まる (ギリギリ収まる)", () => {
    const [, xmax] = cfg.canvasXlim;
    // sx=0.8 まではちょうど収まり、それ以上は右端をはみ出す位置に置く。
    const p = makePlacement({ y: 1.25 });
    p.x = xmax - widthAt(p, 0.8, cfg);
    relaxNameCondense([p], cfg);
    const tol = 1 / (cfg.svgUnitsPerMm * cfg.mmPerUnit + 1e-9);
    let expected = 0.7;
    for (let g = 0.7; g <= 1 + 1e-9; g = Math.round((g + 0.025) * 1000) / 1000) {
      if (p.x + widthAt(p, g, cfg) <= xmax + tol) expected = g;
    }
    expect(p.nameScaleX).toBeCloseTo(expected, 6);
    expect(p.nameScaleX!).toBeLessThan(1);
    expect(placementBox(p, cfg).right).toBeLessThanOrEqual(xmax + tol);
  });

  it("縦に重なる隣接ラベルとの交差を新たに作らない", () => {
    const a = makePlacement({ x: cfg.canvasXlim[0], y: 1.25 });
    // a の右隣 (同じ y) に原寸の障害ラベル。a は b.x を超えて広がれない。
    const gap = a.x + widthAt(a, 0.7, cfg) + 0.02;
    const b = makePlacement({ x: gap, nameScaleX: 1, y: 1.25 });
    relaxNameCondense([a, b], cfg);
    expect(b.nameScaleX).toBe(1);
    expect(placementBox(a, cfg).right).toBeLessThanOrEqual(b.x + 1e-6);
    let expected = 0.7;
    for (let g = 0.7; g <= 1 + 1e-9; g = Math.round((g + 0.025) * 1000) / 1000) {
      if (a.x + widthAt(a, g, cfg) <= b.x + 1e-9) expected = g;
    }
    expect(a.nameScaleX).toBeCloseTo(expected, 6);
  });

  it("insideSlice は対象外 (sx 不変)", () => {
    const p = makePlacement({ insideSlice: true, anchor: "middle", x: 0.3, y: 0 });
    relaxNameCondense([p], cfg);
    expect(p.nameScaleX).toBe(0.7);
  });

  it("anchor=middle で pie に近づく広がりは拒否される", () => {
    // 初期状態で既に pie clearance 内 → どのステップも「より近づく」ため全て revert。
    const p = makePlacement({ anchor: "middle", x: 1.3, y: 0 });
    const before = distToPie(placementBox(p, cfg));
    expect(before).toBeLessThan(cfg.pieRadius + radialFraction(cfg, 0.01, 0.1));
    relaxNameCondense([p], cfg);
    expect(p.nameScaleX).toBe(0.7);
  });

  it("sx は 1 を超えず、減りもしない", () => {
    const p = makePlacement({ x: cfg.canvasXlim[0], y: 1.25, nameScaleX: 0.975 });
    const q = makePlacement({ x: 0.2, y: -1.25, anchor: "middle", nameScaleX: 1 });
    relaxNameCondense([p, q], cfg);
    expect(p.nameScaleX).toBe(1);
    expect(q.nameScaleX).toBe(1);
  });
});
