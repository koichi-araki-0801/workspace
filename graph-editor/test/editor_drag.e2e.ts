// =============================================================================
// editor_drag.e2e.ts — ラベル移動時の leader 端点不変条件を検証する E2E (Playwright)
// =============================================================================

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// `ui.html` を実ブラウザ(Chromium)へロードし、実 `getBBox` を使ってラベルを移動したとき
// 引出線(leader)の端点が「必ずラベル外枠上」に来る不変条件を検証する E2E。
const SVG = readFileSync(new URL("./fixtures/editor_pie.svg", import.meta.url), "utf8");

type Pt = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };
type Sample = { box: Box; pts: Pt[]; leaderVisible: boolean; dAttr: string | null };

const EPS = 0.5; // 実 `getBBox` とパス文字列の丸めを吸収する許容誤差(px)

declare global {
  interface Window {
    __editor: any;
  }
}

/** 点 `p` が外枠 `box` の辺/角上(=境界距離≈0 かつ矩形範囲内)にあるか。 */
function onFrame(p: Pt, box: Box) {
  const within = p.x >= box.left - EPS && p.x <= box.right + EPS && p.y >= box.top - EPS && p.y <= box.bottom + EPS;
  const onEdge =
    Math.abs(p.x - box.left) < EPS ||
    Math.abs(p.x - box.right) < EPS ||
    Math.abs(p.y - box.top) < EPS ||
    Math.abs(p.y - box.bottom) < EPS;
  return within && onEdge;
}

/** `clampPointToBox` の node 側参照実装 (端点の期待値算出用)。 */
function clamp(p: Pt, box: Box): Pt {
  return { x: Math.max(box.left, Math.min(p.x, box.right)), y: Math.max(box.top, Math.min(p.y, box.bottom)) };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/ui.html");
  await page.waitForFunction(() => !!window.__editor);
  await page.evaluate(async (svg) => {
    await window.__editor.load({ name: "fixture", id: 1, content: svg });
  }, SVG);
  // ラベル (`labels`) が構築されるまで待つ
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 2);
});

test("文字を円の周囲へ動かしても引出線端点は常に外枠上 (手動 leader)", async ({ page }) => {
  const samples: Sample[] = await page.evaluate(() => {
    const ed = window.__editor;
    const s = ed.labels.find((l: any) => l.name === "Alpha");
    ed.selectLabel(s);
    const moves = [[120, 0], [0, 160], [-120, 0], [0, -160], [200, 80]];
    const out: Sample[] = [];
    for (const [dx, dy] of moves) {
      ed.nudge(dx, dy);
      ed.flushNow();
      const b = s.text.getBBox();
      const box = {
        left: b.x + s.textTx.x,
        top: b.y + s.textTx.y,
        right: b.x + s.textTx.x + b.width,
        bottom: b.y + s.textTx.y + b.height,
      };
      out.push({
        box,
        pts: s.leaderPts.map((p: any) => ({ x: p.x, y: p.y })),
        leaderVisible: s.leaderVisible,
        dAttr: s.path ? s.path.getAttribute("d") : null,
      });
    }
    return out;
  });

  expect(samples.length).toBe(5);
  for (const smp of samples) {
    expect(smp.pts.length).toBeGreaterThanOrEqual(2);
    expect(smp.leaderVisible).toBe(true);
    const endpoint = smp.pts[smp.pts.length - 1];
    const prev = smp.pts[smp.pts.length - 2];
    // 端点は外枠上にある
    expect(onFrame(endpoint, smp.box), `endpoint ${JSON.stringify(endpoint)} not on frame ${JSON.stringify(smp.box)}`).toBe(true);
    // 端点 = 手前の点を外枠へクランプした点
    const expected = clamp(prev, smp.box);
    expect(endpoint.x).toBeCloseTo(expected.x, 1);
    expect(endpoint.y).toBeCloseTo(expected.y, 1);
    // DOM のパス末尾も同じ端点 (描画まで結線されている)
    expect(smp.dAttr).not.toBeNull();
    const nums = (smp.dAttr as string).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)!.map(Number);
    const domEnd = { x: nums[nums.length - 2], y: nums[nums.length - 1] };
    expect(domEnd.x).toBeCloseTo(endpoint.x, 1);
    expect(domEnd.y).toBeCloseTo(endpoint.y, 1);
  }
});

test("円外で自動生成された引出線端点も外枠上、円内へ戻すと自動削除 (位置駆動)", async ({ page }) => {
  const result = await page.evaluate(() => {
    const ed = window.__editor;
    const s = ed.labels.find((l: any) => l.name === "Beta");
    ed.selectLabel(s);

    // 初期: 円内・leader なし
    const initial = { len: s.leaderPts.length, visible: s.leaderVisible };

    // 円外へ大きく移動 → 自動 leader が生成されるはず
    ed.nudge(-220, 160);
    ed.flushNow();
    const b = s.text.getBBox();
    const box = {
      left: b.x + s.textTx.x,
      top: b.y + s.textTx.y,
      right: b.x + s.textTx.x + b.width,
      bottom: b.y + s.textTx.y + b.height,
    };
    const outside = {
      pts: s.leaderPts.map((p: any) => ({ x: p.x, y: p.y })),
      visible: s.leaderVisible,
      box,
    };

    // 円内へ戻す → 自動分は削除されるはず
    ed.nudge(220, -160);
    ed.flushNow();
    const back = { len: s.leaderPts.length, visible: s.leaderVisible };

    return { initial, outside, back };
  });

  // 初期は leader なし
  expect(result.initial.len).toBe(0);
  expect(result.initial.visible).toBe(false);

  // 円外: 自動生成され端点が外枠上
  expect(result.outside.pts.length).toBeGreaterThanOrEqual(2);
  expect(result.outside.visible).toBe(true);
  const ep = result.outside.pts[result.outside.pts.length - 1];
  expect(onFrame(ep, result.outside.box), `auto endpoint ${JSON.stringify(ep)} not on frame ${JSON.stringify(result.outside.box)}`).toBe(true);

  // 円内へ戻すと自動 leader は除去
  expect(result.back.len).toBe(0);
  expect(result.back.visible).toBe(false);
});
