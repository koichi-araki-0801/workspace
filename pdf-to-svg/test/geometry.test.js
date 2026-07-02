// =============================================================================
// geometry.test.js — `resources/web/geometry.js` の純粋ヘルパの単体テスト (vitest)
// =============================================================================
// フロントの座標変換・ページ範囲指定は状態非依存の純関数。ここを固定しておくことで、
// `--passWithNoTests` の素通り (テスト 0 件でも緑) を解消し、回帰の網を張る。

import { describe, expect, it } from "vitest";
import { clientToPage, parseSpec } from "../resources/web/geometry.js";

describe("parseSpec", () => {
  it("範囲と単発を昇順ユニークに展開する", () => {
    expect(parseSpec("1-5, 8", 100)).toEqual([1, 2, 3, 4, 5, 8]);
  });

  it("逆順の範囲は正順に直す", () => {
    expect(parseSpec("5-3", 100)).toEqual([3, 4, 5]);
  });

  it("重複は 1 つにまとめる", () => {
    expect(parseSpec("1, 1, 2-3, 3", 100)).toEqual([1, 2, 3]);
  });

  it("1..maxPages にクランプする", () => {
    expect(parseSpec("0-3", 2)).toEqual([1, 2]);
    expect(parseSpec("8-12", 10)).toEqual([8, 9, 10]);
  });

  it("空文字・不正トークンは無視する", () => {
    expect(parseSpec("", 10)).toEqual([]);
    expect(parseSpec(" , abc, 2", 10)).toEqual([2]);
    expect(parseSpec(null, 10)).toEqual([]);
  });
});

describe("clientToPage", () => {
  // `viewBox` と要素矩形をスタブした最小の `svgEl` でアフィン変換だけを検証する。
  const svgEl = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 400 }),
    viewBox: { baseVal: { x: 0, y: 0, width: 400, height: 800 } },
  };

  it("要素左上のクライアント座標は viewBox 原点へ写る", () => {
    expect(clientToPage(svgEl, 100, 50)).toEqual({ x: 0, y: 0 });
  });

  it("中心は viewBox 中心へ写る (スケール 2 倍)", () => {
    expect(clientToPage(svgEl, 200, 250)).toEqual({ x: 200, y: 400 });
  });
});
