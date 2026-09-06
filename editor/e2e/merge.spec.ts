// =============================================================================
// merge.spec.ts — 結合PDF タブが選んだ順序で /api/build/merge を呼ぶことの回帰網
// =============================================================================
// local モードでも `mergePdfService` は実サーバの `POST /api/build/merge` を叩くため、
// `page.route` で止めないと vivliostyle CLI が実際に走ってしまう(設計正典 6.3)。
// ここでは要求本文の文書順序(= 追加順)だけを検証し、PDF の実生成はしない。
import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

test('結合PDF: 追加した順に文書が並んで /api/build/merge へ送られる', async ({ page }) => {
  await login(page);

  let requestBody: { documents: { html: string; css: string }[] } | null = null;
  await page.route('**/api/build/merge', async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 fake'),
    });
  });

  await page.goto('/merge', { waitUntil: 'commit' });
  await page.getByText('委託会社コード').first().waitFor();
  await page.getByPlaceholder('委託会社コードを入力/選択').click();
  await page.getByRole('option', { name: 'AM01', exact: true }).click();
  await page.getByRole('button', { name: '検索' }).click();

  // 510155 を先に、510037 を後に追加する(結合順 = 追加順であることを本文の並びで確かめる)。
  const rowLate = page.locator('tbody tr', { hasText: '510155' });
  const rowEarly = page.locator('tbody tr', { hasText: '510037' }).first();
  await expect(rowLate).toBeVisible();

  await rowLate.getByRole('button', { name: '追加' }).click();
  await expect(page.getByText('結合する順序(1件)')).toBeVisible();
  await rowEarly.getByRole('button', { name: '追加' }).click();
  await expect(page.getByText('結合する順序(2件)')).toBeVisible();

  await page.getByRole('button', { name: 'PDF 出力' }).click();
  await expect.poll(() => requestBody?.documents.length ?? 0).toBe(2);
  expect(requestBody?.documents[0].html).toContain('510155');
  expect(requestBody?.documents[1].html).toContain('510037');
});
