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

// プレビュー可視化の退行ガード。ホストページ CSP の connect-src に data: が無いと、
// 表を含む帳票の直接遷移は 5/5 の再現率(実測)で「組版が loading のまま止まり
// ページが永久 hidden」になる — @vivliostyle/core が表セル・脚注用の内蔵 user-agent.xml を
// `data:application/xml,…` の XHR で読む経路が塞がれて文書ロードが中断するため
// (previewHost.ts の PREVIEW_HOST_CSP コメントを見よ)。seed テンプレは表を含むので、
// この直行導線が green であること自体が data: 許可の退行検知になる。マウント直後の
// リサイズ連打は再現プローブの形をそのまま使い、resize 起因の退行(core の resize
// 再レンダ・COMPLETE 前の setOptions)もまとめて網に掛ける。
test('direct preview navigation survives early viewport resizes', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/edit/);

  await page.goto(`/preview/${encodeURIComponent('AM01_510037_20240710_交付版')}`);
  for (let i = 0; i < 20; i++) {
    await page.setViewportSize({ width: 1280 + (i % 2 === 0 ? 16 : -16), height: 720 });
    await page.waitForTimeout(100);
  }
  await expect(
    page
      .frameLocator('iframe[title="プレビュー"]')
      .locator('[data-vivliostyle-page-container]:visible')
      .first(),
  ).toBeVisible({ timeout: 60_000 });
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
