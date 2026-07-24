// =============================================================================
// editor_pie_rules.test.ts — `pie-rules.js` の純粋関数の単体テスト (vitest)
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  parsePieGeometry,
  fallbackPieGeometry,
  labelBox,
  labelCenter,
  isOutsidePie,
  computeDefaultLeaderPts,
} from "../resources/web/js/pie-rules.js";

const EPS = 1e-6;

describe("parsePieGeometry", () => {
  it("楔形パス (M…L…A) から中心と半径を取り出す", () => {
    expect(parsePieGeometry("M300,225 L300,90 A135,135 0 0 1 435,225 Z")).toEqual({ cx: 300, cy: 225, r: 135 });
  });
  it("空白区切り・負座標も許容する", () => {
    expect(parsePieGeometry("M -10.5 20 L0,0 A 7.25,7.25 0 0 1 3,4")).toEqual({ cx: -10.5, cy: 20, r: 7.25 });
  });
  it("A の無いパス (円弧なし) は null", () => {
    expect(parsePieGeometry("M0,0 L10,10 Z")).toBeNull();
    expect(parsePieGeometry("")).toBeNull();
  });
});

describe("fallbackPieGeometry", () => {
  it("キャンバス中央・短辺 × ratio", () => {
    expect(fallbackPieGeometry(600, 450, 0.35)).toEqual({ cx: 300, cy: 225, r: 450 * 0.35 });
  });
});

describe("labelBox / labelCenter", () => {
  const bbox = { x: 10, y: 20, width: 100, height: 30 };
  it("textTx を反映した外枠を組む", () => {
    expect(labelBox(bbox, { x: 5, y: -5 })).toEqual({ left: 15, top: 15, right: 115, bottom: 45 });
  });
  it("中心点は bbox 中央 + textTx", () => {
    expect(labelCenter(bbox, { x: 5, y: -5 })).toEqual({ x: 65, y: 30 });
  });
});

describe("isOutsidePie", () => {
  const pie = { cx: 0, cy: 0, r: 100 };
  it("円内は false / 円外は true (境界ちょうどは内側扱い)", () => {
    expect(isOutsidePie({ x: 50, y: 50 }, pie)).toBe(false);
    expect(isOutsidePie({ x: 100, y: 0 }, pie)).toBe(false);
    expect(isOutsidePie({ x: 101, y: 0 }, pie)).toBe(true);
  });
});

describe("computeDefaultLeaderPts", () => {
  const pie = { cx: 0, cy: 0, r: 100 };

  it("端点はラベル外枠上で円中心に最も近い点", () => {
    const box = { left: 150, top: -20, right: 250, bottom: 20 };
    const anchor = { x: 100, y: 0 };
    const [a, ep] = computeDefaultLeaderPts(pie, box, anchor, EPS);
    expect(a).toEqual(anchor); // アンカーは渡された中心角リム点をそのまま使う
    expect(ep).toEqual({ x: 150, y: 0 }); // 左辺の中央 (中心へ最近)
  });

  it("anchor 未取得 (null) は中心→端点方向のリム点へ退避する", () => {
    const box = { left: 150, top: -20, right: 250, bottom: 20 };
    const [a, ep] = computeDefaultLeaderPts(pie, box, null, EPS);
    expect(ep).toEqual({ x: 150, y: 0 });
    expect(a.x).toBeCloseTo(100, 6); // 方向 (1,0) の r=100 リム点
    expect(a.y).toBeCloseTo(0, 6);
  });

  it("端点が円中心と一致する退避時は右向きへ既定化する (零ベクトル防御)", () => {
    const box = { left: -10, top: -10, right: 10, bottom: 10 }; // 中心を含む箱 → 端点 = 中心
    const [a, ep] = computeDefaultLeaderPts(pie, box, null, EPS);
    expect(ep).toEqual({ x: 0, y: 0 });
    expect(a).toEqual({ x: 100, y: 0 });
  });
});
