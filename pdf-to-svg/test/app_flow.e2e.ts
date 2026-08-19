// =============================================================================
// app_flow.e2e.ts — 4 ステップ UI の実画面通し E2E (Playwright + 実 Python バックエンド)
// =============================================================================
// `app.js` の状態機械リファクタに先行して回帰網を敷く。取込 (upload) → 用語置換
// (辞書追加・再適用) → 要素削除と Undo → SVG 書き出し、を実ブラウザ + 実 RPC で通し、
// 書き出した SVG の中身 (置換済み・削除済み) まで検証する。

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const FIXTURE = new URL("./fixtures/sample.pdf", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

// サーバは `/rpc` `/upload` 等にセッショントークンを要求する (`web/origin_guard.py` の G6)。
// 本番は起動ごとの CSPRNG 値を `--app=` の URL で渡すので、E2E も同じ経路 (URL クエリ) で
// 渡す。値は `test/e2e_server.py` の `TOKEN` と一致させること。
const TOKEN = "e2e-fixed-session-token";

test("4 ステップ通し: 取込 → 置換 → 削除/Undo → 書き出し", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?token=${TOKEN}`);

  // ショートカットの発火を数えるため `rpc` を包む。押下ハンドラは同期に `rpc` を呼ぶので、
  // 押した直後に記録を見れば発火の有無が確定する。
  await page.evaluate(() => {
    const w = window as any;
    w.__rpcLog = [];
    const orig = w.rpc;
    w.rpc = function (method: string, args: unknown) { w.__rpcLog.push(method); return orig(method, args); };
  });
  // ファイルを 1 つも読み込んでいない間は文書のショートカットを撃たない
  await page.keyboard.press("Control+z");
  expect(await page.evaluate(() => (window as any).__rpcLog)).toEqual([]);

  // ── 1. PDF を選ぶ (動的 `<input type=file>` は filechooser イベントで受ける) ──
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#btn-pick"),
  ]);
  await chooser.setFiles(FIXTURE);
  await expect(page.locator("#filelist-count")).toContainText("1 ファイル", { timeout: 30_000 });

  // ── 2. 用語を置換 (辞書タブ → 追加 → 再適用。ヘッダ・本文を問わず全文が対象) ──
  await page.click("#btn-next");
  await expect(page.locator('[data-screen="2"]')).toHaveClass(/on/);
  await page.click('[data-tab="dict"]');
  await page.fill("#dict-src", "Revenue");
  await page.fill("#dict-tgt", "売上高");
  await page.click("#dict-add");
  await expect(page.locator("#dict-count")).toContainText("1");
  // 辞書に語を足しただけで、その語に当たるページは「要確認」に上がる (再適用の前でも)
  await expect(page.locator("#nav-hint")).toContainText("要確認 1");
  await page.click("#btn-reapply");
  // 「N 件置換」ヒントは直後の render() が状態行で上書きするため文言では見ない。
  // 置換の成立は「要確認 1 (changed 化)」とページ表示 (書き出しと同一経路) で確認する。
  await expect(page.locator("#nav-hint")).toContainText("要確認 1");
  await expect(page.locator("#doc-master")).toContainText("売上高", { timeout: 15_000 });

  // 箇所単位: 一覧の「戻す」で 1 件だけ置換前へ → 行は未置換 (置換ボタン) になる → 「置換」で再び当たる
  await page.click('[data-tab="confirm"]');
  const rows = page.locator("#confirm-dyn .change-row");
  await expect(rows.first().locator(".num")).toHaveText("1");
  // 番号マーカーは一覧の行数と同数だけページ上に描かれる
  await expect(page.locator("#doc-master svg [data-editor-marks] > g")).toHaveCount(await rows.count());
  await rows.first().locator(".act-revert").click();
  await expect(page.locator("#doc-master")).toContainText("Revenue", { timeout: 15_000 });
  await expect(page.locator("#confirm-dyn")).toContainText("未置換 1 件");
  await page.locator("#confirm-dyn .change-row").first().locator(".act-apply").click();
  await expect(page.locator("#doc-master")).toContainText("売上高", { timeout: 15_000 });
  await expect(page.locator("#confirm-dyn")).not.toContainText("未置換");

  // 入力欄でのショートカットは文書の Undo を撃たない。辞書の語を打ち直そうと Ctrl+Z した
  // だけで直前の置換が消えると、消えたことに気付けないため。
  await page.click('[data-tab="dict"]');
  await page.click("#dict-src");
  await page.evaluate(() => { (window as any).__rpcLog.length = 0; });
  await page.press("#dict-src", "Control+z");
  await page.press("#dict-src", "Control+y");
  expect(await page.evaluate(() => (window as any).__rpcLog)).toEqual([]);

  // ── 3. 不要範囲を削除: 要素クリック選択 → 削除 → Undo → 再削除 ──
  await page.click('[data-screen="2"] [data-skipall]'); // 未確認をまとめてスキップ → 手順3 へ
  await expect(page.locator('[data-screen="3"]')).toHaveClass(/on/);
  const target = page.locator('#trim-stage svg [data-el]', { hasText: "DeleteMe" });
  await target.click();
  await page.click("#btn-deletesel");
  await expect(page.locator("#trim-dyn")).toContainText("削除した要素（1）");
  await page.click("#btn-undo"); // 直近の削除を取り消す
  await expect(page.locator("#trim-dyn")).toContainText("削除した要素（0）");
  await page.locator('#trim-stage svg [data-el]', { hasText: "DeleteMe" }).click();
  await page.click("#btn-deletesel");
  await expect(page.locator("#trim-dyn")).toContainText("削除した要素（1）");

  // 行ごとの「戻す」は直近の undo ではなく、その要素だけを戻す
  await page.locator("#trim-dyn [data-restore]").first().click();
  await expect(page.locator("#trim-dyn")).toContainText("削除した要素（0）");
  await page.locator('#trim-stage svg [data-el]', { hasText: "DeleteMe" }).click();
  await page.click("#btn-deletesel");
  await expect(page.locator("#trim-dyn")).toContainText("削除した要素（1）");

  // ── 4. SVG に書き出す (1 ページ → 単一 SVG ダウンロード) ──
  await page.click('[data-screen="3"] [data-skipall]');
  await expect(page.locator("#btn-export")).toBeVisible();

  // 書き出しの失敗は握り潰さず通知し、ボタンを押せる状態へ戻す
  await page.evaluate(() => {
    const w = window as any;
    w.__origRpc = w.rpc;
    w.rpc = function (method: string, args: unknown) {
      if (method === "exportSvg") return Promise.reject(new Error("書き出し失敗テスト"));
      return w.__origRpc(method, args);
    };
  });
  await page.click("#btn-export");
  await expect(page.locator("#toast")).toContainText("書き出し失敗テスト");
  await expect(page.locator("#btn-export")).toBeEnabled();
  await page.evaluate(() => { const w = window as any; w.rpc = w.__origRpc; });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#btn-export"),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.svg$/i);
  const saved = await download.path();
  const svgText = readFileSync(saved, "utf8");
  expect(svgText).toContain("売上高");   // 置換が成果物へ反映されている
  expect(svgText).not.toContain("DeleteMe"); // 削除が成果物へ反映されている
});
