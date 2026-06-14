import { expect, test } from '@playwright/test';

// Each test gets a clean localStorage so a stale session never leaks across runs.
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

  // After a successful login the router resolves the redirect to the edit tab.
  await expect(page).toHaveURL(/\/edit/);
});

test('wrong credentials show an error and stay on login', async ({ page }) => {
  await page.goto('/login');

  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('wrong-password');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // The form shows an inline error (a toast with role="alert" also appears, so
  // scope the assertion to the form to keep the locator unambiguous).
  await expect(
    page.locator('form').getByText('ユーザーIDまたはパスワードが違います'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
