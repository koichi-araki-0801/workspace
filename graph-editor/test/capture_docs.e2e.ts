// =============================================================================
// capture_docs.e2e.ts — 操作手順書向けの編集画面スクリーンショット取得 (Playwright)
// =============================================================================
// 操作手順書 (`docs/graph-editor`) 向けのスクリーンショット取得。実行は
//   pnpm exec playwright test test/capture_docs.e2e.ts
// `editor_server.mjs`(:5179) が `ui.html` を配信し、pie-chart のサンプル SVG を
// `window.__editor.load()` でプログラム的に読み込んで編集画面を撮る
// (File System Access API を経由しないので CI/ヘッドレスで安定)。
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SVG = readFileSync(
	resolve(here, "../../pie-chart/out/svg_js/asset_balanced_8.svg"),
	"utf8",
);
const IMAGES = resolve(here, "../../docs/graph-editor/images");

test.use({ viewport: { width: 1280, height: 820 } });

/** サンプル SVG を読み込み、引出線を持つラベルを 1 つ選択した状態にする。 */
async function loadAndSelect(page: import("@playwright/test").Page) {
	await page.goto("/ui.html");
	await page.waitForFunction(
		() => !!(window as Window & { __editor?: unknown }).__editor,
	);
	// サンプル SVG を読み込ませる (実ファイル選択ダイアログを使わない)。
	await page.evaluate(
		(svg) =>
			(window as unknown as { __editor: any }).__editor.load({
				name: "資産配分",
				id: 1,
				content: svg,
			}),
		SVG,
	);
	await page.waitForFunction(
		() => (window as unknown as { __editor: any }).__editor.labels?.length >= 2,
	);
	// 引出線 (曲点を含む点列) を持つラベルを優先して選択し、ハンドル 3 種を見せる。
	await page.evaluate(() => {
		const ed = (window as unknown as { __editor: any }).__editor;
		const withLeader = ed.labels.find(
			(l: any) => (l.leaderPts?.length ?? 0) >= 3,
		);
		ed.selectLabel(withLeader ?? ed.labels[0]);
	});
	await page.waitForTimeout(400);
}

/** 選択中ラベル (ハンドル込み) の周囲を切り出す clip 矩形を求める。 */
async function selectedClip(page: import("@playwright/test").Page) {
	const box = await page.evaluate(() => {
		const g = document.querySelector("g.label.is-selected");
		const r = (g as SVGGElement).getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});
	const pad = 90;
	return {
		x: Math.max(0, box.x - pad),
		y: Math.max(0, box.y - pad),
		width: box.width + pad * 2,
		height: box.height + pad * 2,
	};
}

test("capture open_screen (手順1)", async ({ page }) => {
	await page.goto("/ui.html");
	await page.waitForFunction(
		() => !!(window as Window & { __editor?: unknown }).__editor,
	);
	await page.waitForTimeout(300);
	await page.screenshot({ path: resolve(IMAGES, "open_screen.png") });
});

test("capture editor_main (手順2 全体)", async ({ page }) => {
	await loadAndSelect(page);
	await page.screenshot({ path: resolve(IMAGES, "editor_main.png") });
});

test("capture handles_zoom / condense_zoom (ハンドルと長体の拡大)", async ({
	page,
}) => {
	await loadAndSelect(page);
	const clip = await selectedClip(page);
	await page.screenshot({
		path: resolve(IMAGES, "handles_zoom.png"),
		clip,
	});
	// 長体スライダを 70% へ (ユーザー操作と同じ input イベント経由で反映)。
	await page.evaluate(() => {
		const r = document.getElementById("scaleRange") as HTMLInputElement;
		r.value = "0.7";
		r.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.waitForTimeout(400);
	await page.screenshot({
		path: resolve(IMAGES, "condense_zoom.png"),
		clip,
	});
});

test("capture panel_right (右パネル)", async ({ page }) => {
	await loadAndSelect(page);
	await page
		.locator(".panel")
		.screenshot({ path: resolve(IMAGES, "panel_right.png") });
});

test("capture save_screen (手順3)", async ({ page }) => {
	await loadAndSelect(page);
	await page.evaluate(() => {
		(window as unknown as { __editor: any }).__editor.goPhase(3);
	});
	await page.waitForTimeout(300);
	await page.screenshot({ path: resolve(IMAGES, "save_screen.png") });
});
