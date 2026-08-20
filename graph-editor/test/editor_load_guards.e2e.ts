// =============================================================================
// editor_load_guards.e2e.ts — 読込時の資源上限と中断時の状態 (Playwright / 実 Chromium)
// =============================================================================
// 主張は 2 つで、どちらも**実ブラウザでしか確かめられない**もの:
//
// 1. **上限が効くこと**: ラベル数・ノード数が上限を超える入力は、途中まで読むのでは
//    なく読込ごと拒否し、件数を利用者へ通知する。速度そのものは端末依存で測っても脆いので、
//    「超過したら明示的に拒否する」ことをテストの主張にする。
// 2. **中断しても前のファイルが残らないこと**: 読込は `ed.name` を新ファイルへ
//    切り替えてから走るため、途中で止まるとキャンバスだけ旧ファイルのまま残り、そのまま
//    保存すると旧内容が新ファイル名で書き出される。中断経路は必ず空状態へ倒す。

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

declare global {
  interface Window {
    __editor: any;
  }
}

/** 上限値は**実装のソースから読む** (テスト側へ数値を写すと、実装だけ緩めても緑のままになる)。 */
function constantFrom(url: URL, re: RegExp) {
  const n = Number(re.exec(readFileSync(url, "utf8"))?.[1]);
  if (!Number.isFinite(n)) throw new Error(`上限値を実装から読めませんでした: ${re}`);
  return n;
}

const MAX_LABELS = constantFrom(
  new URL("../resources/web/js/constants.js", import.meta.url), /maxLabels:\s*(\d+)/);
const MAX_NODES = constantFrom(
  new URL("../resources/web/js/utils.js", import.meta.url), /MAX_SVG_NODES\s*=\s*(\d+)/);

/** ノード数の上限を確実に超える詰め物。 */
const NODE_FLOOD = '<circle cx="1" cy="1" r="1"/>'.repeat(MAX_NODES + 1000);

/** ラベル `count` 個を持つ最小 SVG。`extra` はルート直下へ足す任意マークアップ。 */
function svgWithLabels(count: number, extra = "") {
  const labels = Array.from({ length: count }, (_, i) =>
    `<g class="label" data-name="L${i}" data-percent="1"><text x="10" y="${10 + i}" fill="#111111">` +
    `<tspan x="10">L${i}</tspan><tspan x="10" dy="1.1em">1%</tspan></text></g>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450" width="600" height="450">` +
    `<g id="slices"><g class="slice" data-name="L0"><path d="M300,225 L300,90 A135,135 0 0 1 435,225 Z" fill="#4e79a7"/></g></g>` +
    `<g id="labels">${labels}</g>${extra}</svg>`;
}

/** 読込後の観測点をまとめて取り出す (キャンバス実体 + エディタ状態 + 通知文言)。 */
async function loadAndInspect(page: import("@playwright/test").Page, name: string, content: string) {
  return page.evaluate(async ({ name, content }) => {
    const ed = window.__editor;
    await ed.load({ name, id: Math.floor(Math.random() * 1e9), content });
    const canvas = document.querySelector("#canvas");
    return {
      name: ed.name,
      currentId: ed.currentId,
      labels: ed.labels.length,
      hasSvg: !!ed.svg,
      canvasSvgCount: canvas ? canvas.querySelectorAll("svg").length : -1,
      canvasLabelCount: canvas ? canvas.querySelectorAll("#labels > g.label").length : -1,
      saveDisabled: !!ed.dom.btnSave.disabled,
      status: document.querySelector("#status")?.textContent ?? "",
    };
  }, { name, content });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/ui.html");
  await page.waitForFunction(() => !!window.__editor);
});

test("ラベル数の上限を超える SVG は読込ごと拒否し、件数を通知する", async ({ page }) => {
  const r = await loadAndInspect(page, "too_many.svg", svgWithLabels(MAX_LABELS + 1));

  // 部分的に読み込んで「一部だけ編集できる」状態にしない。
  expect(r.hasSvg).toBe(false);
  expect(r.labels).toBe(0);
  expect(r.canvasSvgCount).toBe(0);
  expect(r.saveDisabled).toBe(true);
  // 黙って消さず、実数と上限の両方を出す。
  expect(r.status).toContain(String(MAX_LABELS + 1));
  expect(r.status).toContain(String(MAX_LABELS));
  expect(r.status).toContain("上限");
});

test("上限内のラベル数は従来どおり読める (上限が実用範囲を切らない)", async ({ page }) => {
  const n = Math.min(100, MAX_LABELS);
  const r = await loadAndInspect(page, "ok.svg", svgWithLabels(n));

  expect(r.hasSvg).toBe(true);
  expect(r.labels).toBe(n);
  expect(r.canvasLabelCount).toBe(n);
});

test("ノード数の上限を超える SVG は解釈不能として拒否する", async ({ page }) => {
  // 入力長 8MiB の制限は「小さなノードを大量に詰める」形を止められないので、ノード数側の
  // 予算で切れることを見る (1 ノードあたり ~28 バイト = 数百 KB 程度の入力)。
  const r = await loadAndInspect(page, "too_many_nodes.svg", svgWithLabels(2, NODE_FLOOD));

  expect(r.hasSvg).toBe(false);
  expect(r.labels).toBe(0);
  expect(r.canvasSvgCount).toBe(0);
  expect(r.status).toContain("解釈できませんでした");
});

test("読込を中断しても前のファイルの図・状態がキャンバスに残らない", async ({ page }) => {
  const first = await loadAndInspect(page, "first.svg", svgWithLabels(3));
  expect(first.hasSvg).toBe(true);
  expect(first.canvasLabelCount).toBe(3);

  // 2 枚目は拒否される入力。名前だけ切り替わって図が残ると、保存時に 1 枚目の内容が
  // 2 枚目のファイル名で書き出される。
  const second = await loadAndInspect(page, "second.svg", svgWithLabels(2, NODE_FLOOD));
  // 表示上のアイデンティティ (ファイル名 / アイテム id) も空へ戻す。残すと「開いていない
  // のに編集中のファイルがある」状態になり、レールの編集中マークも取り残される。
  expect(second.name).toBeNull();
  expect(second.currentId).toBeNull();
  expect(second.hasSvg).toBe(false);
  expect(second.canvasSvgCount).toBe(0);
  expect(second.canvasLabelCount).toBe(0);
  expect(second.labels).toBe(0);
  expect(second.saveDisabled).toBe(true);
});

test("@font-face の宣言名がプロトタイプ由来の語でも読込は完走する", async ({ page }) => {
  // `constructor` / `__proto__` は素のオブジェクト表では継承値を返すため、自前キーだけを
  // 見ないと `re.test` が TypeError になり読込が無言で止まる (キャンバスは前のファイルのまま)。
  const style = "<style>@font-face{constructor:a;__proto__:b}</style>";
  await loadAndInspect(page, "first.svg", svgWithLabels(3));
  const r = await loadAndInspect(page, "crafted.svg", svgWithLabels(2, style));

  expect(r.name).toBe("crafted.svg");
  expect(r.hasSvg).toBe(true);
  expect(r.labels).toBe(2);
  expect(r.canvasLabelCount).toBe(2);
  // 認識できない `<style>` は落ちるので、除去件数が利用者へ出る。
  expect(r.status).toContain("除去");
});

test("読込を中断したらレールの「編集中」マークが残らない", async ({ page }) => {
  const marks = await page.evaluate(async ({ ok, bad }) => {
    const ed = window.__editor;
    ed.items = [
      { name: "first.svg", id: 1, content: ok, edited: false },
      { name: "second.svg", id: 2, content: bad, edited: false },
    ];
    ed._itemSeq = 2;
    await ed.load(ed.items[0]);
    const before = document.querySelectorAll("#fileList .fileitem .rdot").length;
    await ed.load(ed.items[1]);
    return { before, after: document.querySelectorAll("#fileList .fileitem .rdot").length };
  }, { ok: svgWithLabels(3), bad: svgWithLabels(2, NODE_FLOOD) });

  // 読めているうちは 1 件だけ「編集中」。中断後は開いているファイルが無いので 0 件。
  expect(marks.before).toBe(1);
  expect(marks.after).toBe(0);
});
