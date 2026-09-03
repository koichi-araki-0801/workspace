// =============================================================================
// review_tab.spec.ts — 承認タブが対象テンプレートの申請を並べ、1 件ずつ決着できることの回帰網
// =============================================================================
// 対象の決め方(?template= → 編集タブの直前画面 → 空状態)、要約箱 3 つの件数、同時展開の上限、
// 決着後に同じ画面へ留まることを実機で固定する。
import { expect, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page, user: string, pass: string): Promise<void> {
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(pass);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  await page.waitForTimeout(800);
}

async function submitOnce(page: Page): Promise<void> {
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await page.waitForTimeout(1000);
}

test('対象が無ければ誘導し、編集タブで開いたテンプレートの申請を要約箱つきで並べる', async ({
  page,
}) => {
  await login(page, 'admin', 'admin');
  await submitOnce(page);
  await submitOnce(page);

  await login(page, 'approver', 'approver');
  await page.goto('/reviews');
  await expect(page.getByText('編集タブでテンプレートを開いてから')).toBeVisible();

  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(2000);
  await page.getByRole('link', { name: '承認' }).click();
  await page.waitForTimeout(800);

  await expect(page.locator('[data-summary="pending"]')).toContainText('2');
  await expect(page.locator('[data-review-item]')).toHaveCount(2);
  // 先頭だけ展開されている
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(2);

  // 2 件目も開くと合計 4 面。上限 2 件なので 3 件目は無いが、両方開いた状態を確認する
  await page.locator('[data-review-toggle]').nth(1).click();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(4);

  // 先頭を差し戻すと同じ画面に留まり、承認待ちが 1 件に減る
  const first = page.locator('[data-review-item]').first();
  await first.locator('textarea[id^="review-comment"]').fill('数値を確認してください');
  await first.getByRole('button', { name: '差し戻す' }).click();
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/\/reviews/);
  await expect(page.locator('[data-summary="pending"]')).toContainText('1');
  await expect(page.locator('[data-summary="rejected"]')).toContainText('1');
  await expect(page.locator('[data-review-item]')).toHaveCount(1);
});
