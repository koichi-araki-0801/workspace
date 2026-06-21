// =============================================================================
// editor_leader_geom.test.ts — `leader_geom.cjs` の純粋関数の単体テスト (vitest)
// =============================================================================

import { describe, expect, it } from "vitest";
// `ui.html` と共有する純粋関数 (UMD/CJS)。default import で `module.exports` を取り出す。
import geom from "../lib/leader_geom.cjs";

const { clampPointToBox, parsePath, buildPath, parseTranslate, normColor } = geom as {
  clampPointToBox: (p: { x: number; y: number }, box: { left: number; top: number; right: number; bottom: number }) => { x: number; y: number };
  parsePath: (d: string) => Array<{ x: number; y: number }>;
  buildPath: (pts: Array<{ x: number; y: number }>) => string;
  parseTranslate: (t: string | null | undefined) => { x: number; y: number };
  normColor: (c: string | null | undefined) => string | null | undefined;
};

describe("clampPointToBox", () => {
  const box = { left: 0, top: 0, right: 10, bottom: 4 };

  it("左外の点は左辺へ (外枠上の最近点)", () => {
    expect(clampPointToBox({ x: -5, y: 2 }, box)).toEqual({ x: 0, y: 2 });
  });
  it("右外の点は右辺へ", () => {
    expect(clampPointToBox({ x: 99, y: 1 }, box)).toEqual({ x: 10, y: 1 });
  });
  it("上外の点は上辺へ (SVG: 上が小さい y)", () => {
    expect(clampPointToBox({ x: 5, y: -3 }, box)).toEqual({ x: 5, y: 0 });
  });
  it("下外の点は下辺へ", () => {
    expect(clampPointToBox({ x: 5, y: 50 }, box)).toEqual({ x: 5, y: 4 });
  });
  it("斜め外の点は角へクランプ", () => {
    expect(clampPointToBox({ x: -1, y: -1 }, box)).toEqual({ x: 0, y: 0 });
    expect(clampPointToBox({ x: 100, y: 100 }, box)).toEqual({ x: 10, y: 4 });
  });
  it("矩形内の点はそのまま (= 矩形内なら点自身)", () => {
    expect(clampPointToBox({ x: 3, y: 2 }, box)).toEqual({ x: 3, y: 2 });
  });
});

describe("parsePath / buildPath", () => {
  it("M…L… を点列へ", () => {
    expect(parsePath("M1,2 L3,4 L5,6")).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
  });
  it("点列を M…L… へ", () => {
    expect(buildPath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe("M1,2 L3,4");
  });
  it("往復で一致する", () => {
    const d = "M10,20 L-3.5,4 L0,0";
    expect(buildPath(parsePath(d))).toBe(d);
  });
  it("負数・小数・指数表記を読む", () => {
    expect(parsePath("M-1.5,2e1")).toEqual([{ x: -1.5, y: 20 }]);
  });
  it("空文字や数値なしは空配列", () => {
    expect(parsePath("")).toEqual([]);
    expect(parsePath("Z")).toEqual([]);
  });
  it("座標が奇数個なら最後の余りは無視", () => {
    expect(parsePath("M1,2 L3")).toEqual([{ x: 1, y: 2 }]);
  });
});

describe("parseTranslate", () => {
  it("translate(dx,dy) を読む", () => {
    expect(parseTranslate("translate(3,4)")).toEqual({ x: 3, y: 4 });
  });
  it("空白・負数・小数を許容", () => {
    expect(parseTranslate("translate( -2.5 , 6 )")).toEqual({ x: -2.5, y: 6 });
  });
  it("空/不正は原点", () => {
    expect(parseTranslate("")).toEqual({ x: 0, y: 0 });
    expect(parseTranslate(null)).toEqual({ x: 0, y: 0 });
    expect(parseTranslate("rotate(10)")).toEqual({ x: 0, y: 0 });
  });
});

describe("normColor", () => {
  it("white / #fff → #ffffff", () => {
    expect(normColor("white")).toBe("#ffffff");
    expect(normColor("#FFF")).toBe("#ffffff");
  });
  it("black / #000 → #000000", () => {
    expect(normColor("black")).toBe("#000000");
    expect(normColor("#000")).toBe("#000000");
  });
  it("前後空白を除去し小文字化", () => {
    expect(normColor("  #AB12Cd  ")).toBe("#ab12cd");
  });
  it("null はそのまま", () => {
    expect(normColor(null)).toBeNull();
  });
});
