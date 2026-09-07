// =============================================================================
// approve.spec.ts — 承認タブの「承認する」が申請を決着させることの回帰網
// =============================================================================
// `review_tab.spec.ts` は却下(差し戻し)のみを固定しているため、承認自体の決着
// (既定フィルタの承認待ちから外れ、承認済みバッジ + 承認者・日時の表示に変わる)を
// ここで押さえる。
import { expect, test } from '@playwright/test';
import { login, openEditor, submitOnce } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

test('承認タブの「承認する」で区画が決着済み表示に変わる', async ({ page }) => {
  await login(page, 'admin');
  await submitOnce(page, SEED_ID);

  await login(page, 'approver');
  await openEditor(page, SEED_ID);
  await page.getByRole('link', { name: '承認' }).click();

  await expect(page.locator('[data-summary="pending"] .text-2xl')).toHaveText('1');
  const item = page.locator('[data-review-item]').first();
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: '承認する' }).click();

  // 決着後は既定フィルタ(承認待ち)からこの申請が外れ、要約箱の件数が動く。
  await expect(page.locator('[data-summary="pending"] .text-2xl')).toHaveText('0');
  await expect(page.locator('[data-summary="approved"] .text-2xl')).toHaveText('1');
  await expect(page.locator('[data-review-item]')).toHaveCount(0);

  // 「承認済み」の箱を押すと決着済み表示(承認済みバッジ + 承認者・日時)で 1 件出る。
  await page.locator('[data-summary="approved"]').click();
  const decided = page.locator('[data-review-item]').first();
  await expect(decided).toContainText('承認済み');
  await expect(decided).toContainText('精査花子'); // approver の displayName(fixtures)
});
