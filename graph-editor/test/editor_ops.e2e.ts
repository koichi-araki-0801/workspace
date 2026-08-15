// =============================================================================
// editor_ops.e2e.ts — Undo/Redo・保存 bake・インスペクタ操作の E2E (Playwright)
// =============================================================================
// `editor.js` の責務分割 (リファクタ) に先行して回帰網を敷く。ドラッグ系の不変条件は
// `editor_drag.e2e.ts` が担当し、本ファイルは「状態遷移 (履歴)」「保存出力のクリーン性」
// 「インスペクタの実クリック配線」を実ブラウザで固定する。

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const SVG = readFileSync(new URL("./fixtures/editor_pie.svg", import.meta.url), "utf8");

declare global {
  interface Window {
    __editor: any;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/ui.html");
  await page.waitForFunction(() => !!window.__editor);
  await page.evaluate(async (svg) => {
    await window.__editor.load({ name: "fixture", id: 1, content: svg });
  }, SVG);
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 2);
});

test("Undo/Redo がラベル位置を往復し、新規操作で redo 分岐を破棄する", async ({ page }) => {
  const r = await page.evaluate(() => {
    const ed = window.__editor;
    const s = ed.labels.find((l: any) => l.name === "Alpha");
    ed.selectLabel(s);
    const at = () => ({ x: s.textTx.x, y: s.textTx.y });

    ed.nudge(30, 20);
    ed.nudge(10, 0);
    const afterMoves = at();
    ed.undo();
    const afterUndo1 = at();
    ed.undo();
    const afterUndo2 = at();
    ed.redo();
    const afterRedo = at();
    // 新規操作 (nudge) は redo 分岐を破棄する
    ed.nudge(0, 5);
    const redoLenAfterNewOp = ed.redoStack.length;
    return { afterMoves, afterUndo1, afterUndo2, afterRedo, redoLenAfterNewOp };
  });

  expect(r.afterMoves).toEqual({ x: 40, y: 20 });
  expect(r.afterUndo1).toEqual({ x: 30, y: 20 });
  expect(r.afterUndo2).toEqual({ x: 0, y: 0 });
  expect(r.afterRedo).toEqual({ x: 30, y: 20 });
  expect(r.redoLenAfterNewOp).toBe(0);
});

test("保存 bake: transform 焼き込み・編集用要素の除去・元サイズ復元", async ({ page }) => {
  const out: string = await page.evaluate(() => {
    const ed = window.__editor;
    const s = ed.labels.find((l: any) => l.name === "Alpha");
    ed.selectLabel(s);
    ed.nudge(30, 20);
    ed.flushNow(); // 選択を移す前に Alpha の DOM 反映を確定 (描画は選択中ラベルのみ)
    // 非表示 leader が bake で除去されることも見る: Beta に leader を付けて非表示化
    const b = ed.labels.find((l: any) => l.name === "Beta");
    ed.selectLabel(b);
    ed.inspectorAction("leaderAdd");
    ed.inspectorAction("leaderOff");
    ed.flushNow();
    ed.zoom = 2; // 表示ズーム中でも出力は元サイズであること
    ed.applyZoom();
    return ed.bakeSvg();
  });

  expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  // 編集専用要素・クラスが残らない
  expect(out).not.toContain("data-editor");
  expect(out).not.toContain("label-hit");
  // Beta が選択状態のまま bake しても選択マーカー(予約 data-editor-sel)が残らない
  expect(out).not.toContain("data-editor-sel");
  expect(out).not.toContain("editor-overlay");
  // Alpha: x=529+30 / y=68+20 に焼き込まれ transform は残らない
  expect(out).toContain('x="559"');
  expect(out).toContain('y="88"');
  expect(out).not.toContain("translate(30");
  // ズーム表示ではなく元サイズへ復元
  expect(out).toContain('width="600px"');
  expect(out).toContain('height="450px"');
  // Beta の非表示 leader は除去される (path は Alpha の leader と slices のみ)
  const betaGroup = out.match(/<g[^>]*data-name="Beta"[^>]*class="label"[\s\S]*?<\/g>/) ??
    out.match(/<g[^>]*class="label"[^>]*data-name="Beta"[\s\S]*?<\/g>/);
  expect(betaGroup).not.toBeNull();
  expect(betaGroup![0]).not.toContain("<path");
});

test("インスペクタの実クリックで leader 追加・曲げ点・行数・文字色・リセットが配線されている", async ({ page }) => {
  // Beta (leader なし・円内) を選択してインスペクタを開く
  await page.evaluate(() => {
    const ed = window.__editor;
    ed.selectLabel(ed.labels.find((l: any) => l.name === "Beta"));
  });

  const state = () =>
    page.evaluate(() => {
      const s = window.__editor.selected;
      return {
        pts: s.leaderPts.length,
        visible: s.leaderVisible,
        fill: s.fill,
        lineCount: s.lineCount,
        tx: { ...s.textTx },
      };
    });

  // 引出線「表示」(leader 無し時は追加として動く)
  await page.click('[data-act="leaderAdd"]');
  expect(await state()).toMatchObject({ pts: 2, visible: true });

  // 曲げ点「あり」→ 3 点化
  await page.click('[data-act="bendAdd"]');
  expect(await state()).toMatchObject({ pts: 3 });

  // 行数「2行」→ tspan が 2 行構成に組み直される
  await page.click('[data-act="lines2"]');
  expect((await state()).lineCount).toBe(2);
  const tspanRows = await page.evaluate(() => {
    const s = window.__editor.selected;
    window.__editor.flushNow();
    return [...s.text.querySelectorAll("tspan")].filter((t: any) => t.hasAttribute("x")).length;
  });
  expect(tspanRows).toBe(2);

  // 文字色「白」
  await page.click('[data-act="insideOn"]');
  expect((await state()).fill).toBe("#ffffff");

  // このラベルをリセット → 初期状態 (leader なし・1 行・元色) へ戻る
  await page.click('[data-act="resetOne"]');
  expect(await state()).toMatchObject({ pts: 0, visible: false, lineCount: 1, fill: "#111111" });
});
