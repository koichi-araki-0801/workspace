// =============================================================================
// editor_sanitize.e2e.ts — 未信頼 SVG 取り込みの迂回テスト (Playwright / 実 Chromium)
// =============================================================================
// 読み込んだ SVG はアプリ origin の生 DOM へインライン挿入される (`getBBox` の実測が
// 要るため)。したがって「危険物が実行されないこと」は実ブラウザでしか主張できない。
//
// 本ファイルは**denylist では止まらない迂回入力を並べ、それが失敗すること**を主張する。
// 個別の要素名・属性名を数える形にはしない (次の別名で無力化されるため)。代わりに
// 「出力ツリーに名前空間つき属性が 1 つも無い」「ELEMENT / TEXT 以外のノードが無い」
// のような**不変条件**を主張する。

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PIE_SAMPLE = readFileSync(new URL("./fixtures/pie_sample.svg", import.meta.url), "utf8");

declare global {
  interface Window {
    __editor: any;
    __pwned?: unknown;
    __c3?: unknown;
    __x1?: unknown;
  }
}

/** slices / labels を備えた最小 SVG に、迂回用のマークアップ `inner` を足す。
 *  `rootAttrs` は名前空間宣言 (`xmlns:xl=…`) を根へ足すための逃げ道。 */
function svgWith(inner: string, rootAttrs = "", sliceFill = "#4e79a7") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450" width="600" height="450" ${rootAttrs}>
  <g id="slices">
    <g class="slice" data-name="Alpha"><path d="M300,225 L300,90 A135,135 0 0 1 435,225 Z" fill="${sliceFill}"/></g>
    <g class="slice" data-name="Beta"><path d="M300,225 L435,225 A135,135 0 0 1 300,360 Z" fill="#f28e2b"/></g>
  </g>
  <g id="labels">
    <g class="label" data-name="Alpha" data-percent="50"><text x="500" y="60" fill="#111111"><tspan x="500">Alpha</tspan><tspan x="500" dy="1.1em">50%</tspan></text></g>
    <g class="label" data-name="Beta" data-percent="50"><text x="360" y="300" fill="#111111"><tspan x="360">Beta</tspan><tspan x="360" dy="1.1em">50%</tspan></text></g>
  </g>
  ${inner}
</svg>`;
}

/** 読み込んだ後の DOM を機械的に走査し、不変条件の判定材料をまとめて返す。 */
async function inspectCanvas(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const svg = document.querySelector("#canvas svg");
    if (!svg) return null;
    const nodeTypes = new Set<number>();
    const elements: string[] = [];
    const nsAttrs: string[] = [];
    const walker = document.createTreeWalker(svg, NodeFilter.SHOW_ALL);
    const visit = (n: Node) => {
      nodeTypes.add(n.nodeType);
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        elements.push(el.localName);
        for (const a of Array.from(el.attributes)) {
          if (a.namespaceURI !== null) nsAttrs.push(`${el.localName}@${a.name}`);
        }
      }
    };
    visit(svg);
    let cur: Node | null;
    while ((cur = walker.nextNode())) visit(cur);
    return {
      nodeTypes: [...nodeTypes],
      elements,
      nsAttrs,
      html: (svg as Element).outerHTML,
    };
  });
}

/** `sanitizeSvg` を直接呼び、除去件数を取る (ページ内の ESM を動的 import)。 */
async function sanitizeCounts(page: import("@playwright/test").Page, svg: string) {
  return page.evaluate(async (text) => {
    // モジュール指定子を変数にするのは tsc への都合 (このパスはページ側の実 URL で、
    // Node 側の解決対象ではない)。
    const specifier = "/js/utils.js";
    const m = await import(specifier);
    const res = m.sanitizeSvg(text);
    return res ? { ok: true, removed: m.removedCount(res.removed) } : { ok: false, removed: -1 };
  }, svg);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/ui.html");
  await page.waitForFunction(() => !!window.__editor);
});

// ── 1. denylist では止まらない 4 経路 ──

test("foreignObject の XHTML iframe が取り込まれず srcdoc も走らない", async ({ page }) => {
  const svg = svgWith(
    `<foreignObject x="0" y="0" width="300" height="200">` +
      `<iframe xmlns="http://www.w3.org/1999/xhtml" ` +
      `srcdoc="&lt;script&gt;parent.__pwned=1&lt;/script&gt;"></iframe>` +
      `</foreignObject>`,
  );
  await page.evaluate((s) => window.__editor.load({ name: "p002", id: 1, content: s }), svg);
  // srcdoc の実行は非同期なので少し待ってから判定する。
  await page.waitForTimeout(300);

  const r = await inspectCanvas(page);
  expect(r).not.toBeNull();
  expect(r!.elements).not.toContain("foreignObject");
  expect(r!.elements).not.toContain("iframe");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.querySelectorAll("#canvas iframe").length)).toBe(0);
});

test("animate による href 差し替えが要素ごと落ちる", async ({ page }) => {
  const svg = svgWith(
    `<a href="#safe"><rect id="bait" x="10" y="10" width="80" height="80" fill="#000000"/>` +
      `<animate attributeName="href" values="javascript:window.__c3=1" fill="freeze" dur="0.1s"/></a>`,
  );
  await page.evaluate((s) => window.__editor.load({ name: "p010", id: 1, content: s }), svg);
  await page.waitForTimeout(300);

  const r = await inspectCanvas(page);
  expect(r!.elements).not.toContain("animate");
  expect(r!.elements).not.toContain("a");
  // 餌の `<rect>` ごと (親の `<a>` が許可外なので部分木ごと) 落ちる。
  expect(await page.evaluate(() => document.querySelector("#canvas #bait"))).toBeNull();
  expect(await page.evaluate(() => window.__c3)).toBeUndefined();
});

test("別プレフィックスの xlink も制御文字入りスキームも、名前空間つき属性ごと落ちる", async ({ page }) => {
  const svg = svgWith(
    // (a) 任意プレフィックスでの xlink 宣言 — 文字列比較では無限に別名を作れる。
    `<g xl:href="javascript:window.__c3=1"><rect x="0" y="0" width="10" height="10" fill="#000000"/></g>` +
      // (b) スキーム内部にタブを挟む形 — URL パーサはタブを除いてから解釈する。
      `<g href="java\tscript:window.__c3=1"><rect x="20" y="0" width="10" height="10" fill="#000000"/></g>` +
      // (c) 見慣れない prefix でも同じ名前空間 URI なら同じ扱いになること。
      `<g ev:href="javascript:window.__c3=1"><rect x="40" y="0" width="10" height="10" fill="#000000"/></g>`,
    'xmlns:xl="http://www.w3.org/1999/xlink" xmlns:ev="http://www.w3.org/1999/xlink"',
  );
  await page.evaluate((s) => window.__editor.load({ name: "p011", id: 1, content: s }), svg);

  const r = await inspectCanvas(page);
  // 個別の属性名ではなく「名前空間つき属性が 1 つも無い」ことを主張する。
  expect(r!.nsAttrs).toEqual([]);
  expect(r!.html).not.toContain("href");
  expect(r!.html.toLowerCase()).not.toContain("script:");
  expect(await page.evaluate(() => window.__c3)).toBeUndefined();
});

test("外部 URL を参照する image / @import / @font-face でも外部リクエストが飛ばない", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith("http://127.0.0.1:") && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
  });

  const svg = svgWith(
    `<image href="https://example.invalid/x.png" x="0" y="0" width="10" height="10"/>` +
      `<style>@import url(https://example.invalid/x.css);` +
      `@font-face{font-family:"Evil";src:url(https://example.invalid/f.woff2) format("woff2");}</style>`,
  );
  await page.evaluate((s) => window.__editor.load({ name: "p025", id: 1, content: s }), svg);
  await page.waitForTimeout(500);

  const r = await inspectCanvas(page);
  expect(r!.elements).not.toContain("image");
  // `<style>` は文法に一致しないので丸ごと落ちる (`@import` を消す denylist ではない)。
  expect(r!.elements).not.toContain("style");
  expect(r!.html).not.toContain("example.invalid");
  expect(external).toEqual([]);
});

// ── 2. インスペクタ ──

test("スライスの fill から属性を閉じても、インスペクタへ要素を注入できない", async ({ page }) => {
  const evilFill = "#fff&quot;&gt;&lt;img src=x onerror=&quot;window.__x1=1&quot;&gt;";
  const svg = svgWith("", "", evilFill);
  await page.evaluate((s) => window.__editor.load({ name: "p001", id: 1, content: s }), svg);
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 1);
  await page.evaluate(() => {
    const ed = window.__editor;
    ed.selectLabel(ed.labels.find((l: any) => l.name === "Alpha"));
    ed.flushNow();
  });
  await page.waitForTimeout(200);

  const r = await page.evaluate(() => {
    const body = document.querySelector("#inspectorBody") as HTMLElement;
    const sw = body.querySelector(".selname .sw") as HTMLElement;
    return {
      imgCount: body.querySelectorAll("img").length,
      html: body.innerHTML,
      bg: getComputedStyle(sw).backgroundColor,
      inline: sw.getAttribute("style"),
      name: (body.querySelector(".selname .nm") as HTMLElement).textContent,
    };
  });
  expect(r.imgCount).toBe(0);
  expect(r.html).not.toContain("onerror");
  expect(await page.evaluate(() => window.__x1)).toBeUndefined();
  // 不正な色は CSSOM が黙って無視するので、フォールバックのまま (背景が塗られない)。
  expect(r.inline ?? "").not.toContain("onerror");
  expect(r.bg).not.toBe("rgb(255, 255, 255)");
  expect(r.name).toBe("Alpha 50%");
});

test("正当な fill はこれまでどおり swatch に反映される", async ({ page }) => {
  await page.evaluate((s) => window.__editor.load({ name: "ok", id: 1, content: s }), svgWith("", "", "#4e79a7"));
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 1);
  await page.evaluate(() => {
    const ed = window.__editor;
    ed.selectLabel(ed.labels.find((l: any) => l.name === "Alpha"));
    ed.flushNow();
  });
  const bg = await page.evaluate(
    () => getComputedStyle(document.querySelector("#inspectorBody .selname .sw") as HTMLElement).backgroundColor,
  );
  expect(bg).toBe("rgb(78, 121, 167)");
});

// ── 3. 出力ツリーの不変条件 ──

test("取り込み後の DOM は ELEMENT と TEXT 以外のノードを持たない", async ({ page }) => {
  const svg = svgWith(
    `<!-- comment --><?xml-stylesheet href="https://example.invalid/x.css"?>` +
      `<g><![CDATA[raw]]><rect x="0" y="0" width="5" height="5" fill="#000000"/></g>`,
  );
  await page.evaluate((s) => window.__editor.load({ name: "nodes", id: 1, content: s }), svg);

  const r = await inspectCanvas(page);
  // 1=ELEMENT / 3=TEXT のみ。コメント(8)・処理命令(7)・CDATA(4) は持ち込まない。
  expect(r!.nodeTypes.sort()).toEqual([1, 3]);
  expect(r!.html).not.toContain("example.invalid");
});

test("保存出力は能動コンテンツを持ち越さず、再読込しても 1 件も除去されない", async ({ page }) => {
  const svg = svgWith(
    `<foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;1&lt;/script&gt;"></iframe></foreignObject>` +
      `<a href="#x"><animate attributeName="href" values="javascript:1" fill="freeze"/></a>` +
      `<image href="https://example.invalid/x.png" width="10" height="10"/>` +
      `<g onload="window.__c3=1"><rect x="0" y="0" width="5" height="5" fill="#000000"/></g>`,
    'xmlns:xl="http://www.w3.org/1999/xlink"',
  );
  await page.evaluate((s) => window.__editor.load({ name: "bake", id: 1, content: s }), svg);
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 1);

  const out: string = await page.evaluate(() => window.__editor.bakeSvg());
  for (const bad of ["foreignObject", "iframe", "animate", "javascript", "onerror", "onload", "https://"]) {
    expect(out, bad).not.toContain(bad);
  }
  // 出口が入口を通る (自己一貫性)。ここが 0 でないと `save` は保存を中止する。
  expect(await sanitizeCounts(page, out)).toEqual({ ok: true, removed: 0 });
});

test("許可外を含む入力では除去件数が 0 にならず、利用者に知らされる", async ({ page }) => {
  const svg = svgWith(`<script>window.__c3=1</script>`);
  const counts = await sanitizeCounts(page, svg);
  expect(counts.ok).toBe(true);
  expect(counts.removed).toBeGreaterThan(0);

  await page.evaluate((s) => window.__editor.load({ name: "warn", id: 1, content: s }), svg);
  const status = await page.evaluate(() => (document.querySelector(".footer .skip-note") as HTMLElement)?.textContent);
  expect(status).toContain("除去");
});

test("SVG として解釈できない入力は null (読み込みを中断する)", async ({ page }) => {
  expect(await sanitizeCounts(page, "<html><body>x</body></html>")).toEqual({ ok: false, removed: -1 });
  expect(await sanitizeCounts(page, "not xml at all <<<")).toEqual({ ok: false, removed: -1 });
});

// ── 4. 実用が壊れていないことの主張 ──

test("pie-chart 実出力は 1 件も削られず、フォント・data-* ・textLength が保たれる", async ({ page }) => {
  expect(await sanitizeCounts(page, PIE_SAMPLE)).toEqual({ ok: true, removed: 0 });

  await page.evaluate((s) => window.__editor.load({ name: "pie", id: 1, content: s }), PIE_SAMPLE);
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 4);

  const r = await page.evaluate(() => {
    const svg = document.querySelector("#canvas svg") as SVGSVGElement;
    const style = svg.querySelector("style");
    return {
      labels: window.__editor.labels.length,
      styleCount: svg.querySelectorAll("style").length,
      css: style ? style.textContent || "" : "",
      hasDefs: !!svg.querySelector("defs"),
      hasRect: !!svg.querySelector("rect:not([data-editor-hit])"),
      hasTspan: !!svg.querySelector("tspan"),
      dataNames: [...svg.querySelectorAll("#labels > g.label")].map((g) => g.getAttribute("data-name")),
      slicePathFill: svg.querySelector("#slices g.slice path")?.getAttribute("fill"),
      leaderPaths: svg.querySelectorAll("#labels path").length,
    };
  });
  expect(r.labels).toBe(4);
  expect(r.styleCount).toBe(1);
  expect(r.css).toContain("@font-face");
  expect(r.css).toContain("data:font/woff2");
  expect(r.hasDefs).toBe(true);
  expect(r.hasRect).toBe(true);
  expect(r.hasTspan).toBe(true);
  expect(r.dataNames.every((n) => !!n)).toBe(true);
  expect(r.slicePathFill).toMatch(/^#[0-9a-f]{6}$/i);
  expect(r.leaderPaths).toBeGreaterThan(0);
});

// ── 5. bakeSvg の覆いの穴 2 つ (選択マーカーの予約 data-* 化 / 出口検査の try/catch) ──

test("選択マーカーが列挙漏れで残っても、予約 data-editor-sel を出口 sanitizeSvg が検知する", async ({ page }) => {
  // `bakeSvg` の除去列挙 (`[data-editor-sel]` の属性除去) が将来漏れても、選択マーカーが
  // 予約 `data-*` である限り出口検査は必ず `removed>0` に倒れて保存を止める、という
  // 安全網そのものを主張する (`class="is-selected"` のような素のクラス名は `class` が
  // 値無検査の許可属性なので、この網に掛からなかった)。
  const svg = svgWith(``).replace(
    `<g class="label" data-name="Alpha" data-percent="50">`,
    `<g class="label" data-name="Alpha" data-percent="50" data-editor-sel="1">`,
  );
  const counts = await sanitizeCounts(page, svg);
  expect(counts.ok).toBe(true);
  expect(counts.removed).toBeGreaterThan(0);
});

test("sanitizeSvg が例外を投げても save は保存を中止し、ダウンロードを起こさない", async ({ page }) => {
  // 入口 (:56-65 付近) は既に明示 try/catch 済みだが、出口 `sanitizeSvg(out)` は
  // 未対応だと例外が unhandled rejection になり「保存ボタンを押しても何も起きない」
  // 無言失敗になる。`/js/utils.js` の `sanitizeSvg` を例外を投げる版へ差し替え、
  // save がステータス表示のうえ return し、ダウンロードが起きないことを確かめる。
  // 例外は `window.__throwSanitize` フラグが立っている時だけ投げる — `load` も同じ
  // `sanitizeSvg` を通るため、無条件に投げると読込自体が (これも中断 = 意図どおり)
  // 落ちてしまい、保存経路だけを狙って検証できない。
  await page.route("**/js/utils.js", async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const patched = body.replace(
      "function sanitizeSvg(svgText) {",
      'function sanitizeSvg(svgText) { if (window.__throwSanitize) throw new Error("boom-test");',
    );
    expect(patched).not.toBe(body); // 置換が実際に効いたことの前提 (壊れたら誤検証を防ぐ)
    await route.fulfill({ response: res, body: patched });
  });
  await page.goto("/ui.html");
  await page.waitForFunction(() => !!window.__editor);
  await page.evaluate((s) => window.__editor.load({ name: "throwtest", id: 1, content: s }), PIE_SAMPLE);
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 4);

  let downloadFired = false;
  page.once("download", () => {
    downloadFired = true;
  });
  await page.evaluate(() => {
    (window as unknown as { __throwSanitize: boolean }).__throwSanitize = true;
  });
  await page.evaluate(() => window.__editor.save());
  await page.waitForTimeout(200);

  const status = await page.evaluate(
    () => (document.querySelector(".footer .skip-note") as HTMLElement)?.textContent,
  );
  expect(status).toContain("保存を中止しました");
  expect(downloadFired).toBe(false);
});

test("往復: 保存出力を再度開いても除去 0・ラベル数一致・transform が焼き込まれている", async ({ page }) => {
  await page.evaluate((s) => window.__editor.load({ name: "pie", id: 1, content: s }), PIE_SAMPLE);
  await page.waitForFunction(() => window.__editor.labels && window.__editor.labels.length >= 4);

  const out: string = await page.evaluate(() => {
    const ed = window.__editor;
    ed.selectLabel(ed.labels[0]);
    ed.nudge(12, -7);
    ed.flushNow();
    return ed.bakeSvg();
  });
  expect(out).not.toContain("translate(");
  expect(await sanitizeCounts(page, out)).toEqual({ ok: true, removed: 0 });

  const labels = await page.evaluate(async (s) => {
    await window.__editor.load({ name: "pie2", id: 2, content: s });
    return window.__editor.labels.length;
  }, out);
  expect(labels).toBe(4);
});
