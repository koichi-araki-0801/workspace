// =============================================================================
// smoke.spec.ts — 認証フローの E2E スモークテスト (Playwright)
// =============================================================================
import { expect, test } from '@playwright/test';

// 各テストは localStorage をクリーンにし、古い session が実行間で漏れないようにする。
test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test('unauthenticated visit is redirected to the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'RET' })).toBeVisible();
});

test('demo login lands the user on the edit tab', async ({ page }) => {
  await page.goto('/login');

  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // ログイン成功後、router がリダイレクトを解決して編集タブへ遷移する。
  await expect(page).toHaveURL(/\/edit/);
});

test('wrong credentials show an error and stay on login', async ({ page }) => {
  await page.goto('/login');

  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // フォームにインラインエラーが出る (role="alert" の toast も出るため、locator を
  // 一意に保つようアサーションを form 内へ絞る)。
  await expect(
    page.locator('form').getByText('ユーザーIDまたはパスワードが違います'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
