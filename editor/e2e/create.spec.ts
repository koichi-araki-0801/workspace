// =============================================================================
// create.spec.ts — 作成タブの属性選択から ?created=1 の編集画面へ到達することの回帰網
// =============================================================================
// 「属性から新規作成」は localTemplateRepo.generate を直接呼ぶ(/api/generate 不要)ため、
// ネットワーク待ちが無く即座に編集画面へ遷移する。作成経路(?created=1)= 差し込み値
// ハイライト有りであることを実画面で固定する(設計正典「編集 2 系統」)。生成される id は
// 実行日の基準日を含み事前に分からないため、`openEditor` へは委ねずボタン押下後の遷移先で
// 直接 canvas を待つ。
import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

test('作成タブ: 属性を選んで新規作成すると ?created=1 の編集画面が開きハイライトが出る', async ({
  page,
}) => {
  await login(page);
  await page.goto('/create', { waitUntil: 'commit' });
  await page.getByText('作成するファンドを指定').first().waitFor();

  await page.getByPlaceholder('委託会社コードを入力/選択').click();
  await page.getByRole('option', { name: 'AM01', exact: true }).click();
  await page.getByPlaceholder('ファンドコードを入力/選択').click();
  await page.getByRole('option', { name: /^510037/ }).click();
  // Select トリガの accessible name はプレースホルダ span の中身に付かないため
  // (`getByRole('combobox', { name: ... })` は空名でマッチしない)、表示文字列での絞り込みにする。
  await page.getByRole('combobox').filter({ hasText: '版種を選択' }).click();
  await page.getByRole('option', { name: '交付版', exact: true }).click();

  await page.getByRole('button', { name: '属性から新規作成' }).click();

  await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
  const url = new URL(page.url());
  expect(decodeURIComponent(url.pathname)).toMatch(/^\/edit\/AM01_510037_\d{8}_交付版$/);

  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.locator('body')).toHaveClass(/jinja-vars-highlight/, { timeout: 15_000 });
});
