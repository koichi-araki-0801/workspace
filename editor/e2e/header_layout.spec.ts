// =============================================================================
// header_layout.spec.ts — 編集画面ヘッダが 1 行に収まること
// =============================================================================
// ヘッダは `flex-wrap` で、狭幅では塊ごと次行へ折り返す(`EditorTopBar.vue` のズーム崩れ
// 回避)。ただし通常の画面幅でまで折り返すと、最重要アクションの「プレビュー」だけが
// 2 行目の左端へ孤立する。折り返しの余裕はファンド名の長さと保存状態の文言で簡単に
// 食い潰されるので、その両方が最長の状態で 1 行に収まることを 2 つの幅で固定する。
import { expect, type Page, test } from '@playwright/test';

// 長いファンド名(SMT JPX日経中小型株インデックス・オープン)を持つ seed。ファンド名は
// ヘッダ左ゾーンの幅を決めるので、短い名前の seed では余裕の不足を検出できない。
const LONG_NAME_ID = 'AM01_510124_20251020_交付版';

// 通常系で最も長い保存状態の文言(`EditorView.vue` の `statusText`)。実際にこれを出すには
// 本文を編集して自動保存を待つ必要があり、GrapesJS の RTE 操作を挟むと測定が不安定に
// なるので、文言だけを差し込んで幅を測る。書式を変えたらここも合わせること。異常系の
// 「保存に失敗しました」は再試行ボタンも増えるため、折り返してでも全部出すのが正しく、
// ここでは測らない。
const LONGEST_STATUS = '00:00 に自動保存';

async function login(page: Page) {
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
}

/**
 * ヘッダの子要素が何行に分かれているか。判定に上端でなく**中心の y**を使うのは、
 * 右ゾーンを押しやるスペーサー(`<span class="flex-1" />`)が高さゼロで、上端だと
 * 同じ行にいても他の要素と 20px 以上ずれるため。
 */
async function headerRows(page: Page): Promise<number> {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return -1;
    const centers = Array.from(header.children).map((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const base = Math.min(...centers);
    return new Set(centers.map((y) => Math.round((y - base) / 20))).size;
  });
}

async function openLongNameEditor(page: Page) {
  await login(page);
  await page.goto(`/edit/${encodeURIComponent(LONG_NAME_ID)}`, { waitUntil: 'commit' });
  await page.frameLocator('iframe.gjs-frame').locator('.page').first().waitFor({ timeout: 30_000 });
}

test('1440px: 長いファンド名でもヘッダが 1 行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLongNameEditor(page);
  // この幅では保存状態の文言は出ない(アイコンのみ)。出すと必ず溢れる。
  await expect(page.locator('header [role="status"] span').last()).toBeHidden();
  expect(await headerRows(page)).toBe(1);
});

test('1600px: 保存状態の文言が出る幅でもヘッダが 1 行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openLongNameEditor(page);
  await expect(page.locator('header [role="status"] span').last()).toBeVisible();
  await page.evaluate((status) => {
    const label = document.querySelector('header [role="status"] span:last-child');
    if (label) label.textContent = status;
  }, LONGEST_STATUS);
  await expect(page.locator('header [role="status"]')).toContainText(LONGEST_STATUS);
  expect(await headerRows(page)).toBe(1);
});
