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
const OUT = resolve(here, "../../docs/graph-editor/images/editor_main.png");

test.use({ viewport: { width: 1280, height: 820 } });

test("capture editor_main", async ({ page }) => {
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
	// ラベルを 1 つ選択し、右パネルにプロパティ (編集 UI) が出た状態にする。
	await page.evaluate(() => {
		const ed = (window as unknown as { __editor: any }).__editor;
		ed.selectLabel(ed.labels[0]);
	});
	await page.waitForTimeout(400);
	await page.screenshot({ path: OUT });
});
