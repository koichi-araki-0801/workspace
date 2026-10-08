// =============================================================================
// part_edition.spec.ts — パーツ一覧が編集中テンプレートの版種で絞られること
// =============================================================================
// seed のテンプレートは交付版。対象版種が全体版のパーツは分類の候補にも出ず、交付版のパーツは出る。
import { expect, test } from './fixtures';
import { login, openEditor } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';

test('交付版のテンプレートでは、全体版専用のパーツを一覧に出さない', async ({ page }) => {
  await login(page);
  await openEditor(page, SEED_ID);
  await page.getByText('パーツを追加', { exact: true }).click();

  await page.getByRole('combobox').filter({ hasText: 'カテゴリを選択' }).click();
  await page.getByRole('option', { name: '版種別', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: '大分類を選択' }).click();
  await page.getByRole('option', { name: '案内', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: '中分類を選択' }).click();
  await page.getByRole('option', { name: '見出し', exact: true }).click();
  await page.getByRole('combobox').filter({ hasText: '小分類を選択' }).click();

  await expect(page.getByRole('option', { name: '交付版', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '全体版', exact: true })).toHaveCount(0);
});
