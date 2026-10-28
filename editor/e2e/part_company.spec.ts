// =============================================================================
// part_company.spec.ts — パーツ一覧が委託会社で絞られ、挿入時に値が 2 系統で描き分けられること
// =============================================================================
// seed のテンプレートは XX01。XX02 専用のパーツは一覧に出ない。Jinja のパーツは、編集タブでは
// 値ファイルの値が地の文字で入り、作成タブでは共通サンプルの値がチップで入る。
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { login, openEditor } from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';
const FUND_NAME = 'ダミーバランスファンド（切替型）';

/** 「パーツを追加」を開き、分類を表紙 > 表紙ヘッダー > ファンド名 > 標準まで選んで挿入する。 */
async function insertFundNameTitle(page: Page): Promise<void> {
  await page.getByText('パーツを追加', { exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: 'カテゴリを選択' }).click();
  await page.getByRole('option', { name: '表紙', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: '大分類を選択' }).click();
  await page.getByRole('option', { name: '表紙ヘッダー', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: '中分類を選択' }).click();
  await page.getByRole('option', { name: 'ファンド名', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: '小分類を選択' }).click();
  await page.getByRole('option', { name: '標準', exact: true }).click();
  await page.getByRole('button', { name: '選択したパーツを挿入' }).click();
}

test('他社のパーツを一覧に出さない', async ({ page }) => {
  await login(page);
  await openEditor(page, SEED_ID);
  await page.getByText('パーツを追加', { exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: 'カテゴリを選択' }).click();
  await page.getByRole('option', { name: '表紙', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: '大分類を選択' }).click();

  // XX02 専用のパーツだけが属する大分類は、XX01 のテンプレートの候補に出ない。
  await expect(page.getByRole('option', { name: '表紙ヘッダー', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '表紙右側', exact: true })).toHaveCount(0);
});

test('編集タブで Jinja のパーツを挿入すると値ファイルの値が入る', async ({ page }) => {
  await login(page);
  const frame = await openEditor(page, SEED_ID);
  const titles = frame.locator('h1.cover-title', { hasText: FUND_NAME });
  const before = await titles.count();
  await insertFundNameTitle(page);

  await expect(titles).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(frame.locator('.jinja-chip')).toHaveCount(0);
});

test('作成タブで Jinja のパーツを挿入すると共通サンプルの値がチップで入る', async ({ page }) => {
  await login(page);
  const frame = await openEditor(page, SEED_ID, '?created=1');
  const chips = frame.locator('h1.cover-title .jinja-chip');
  const before = await chips.count();
  await insertFundNameTitle(page);

  await expect(chips).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(chips.last()).toHaveText(FUND_NAME);
});
