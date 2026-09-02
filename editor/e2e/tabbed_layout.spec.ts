// =============================================================================
// tabbed_layout.spec.ts — 編集・プレビュー画面がタブの下に展開されること
// =============================================================================
// 編集・プレビューは MainLayout の子ルートで、アプリヘッダとタブが常に見える。編集画面は
// 残りの高さを全部使う(`h-full`)。タブを押すと、そのタブで直前に見ていた画面へ戻る。
import { expect, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

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

async function openEditor(page: Page, query = '') {
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}${query}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  return frame;
}

test('編集画面でもアプリヘッダとタブが見え、「編集」タブが点灯する', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await openEditor(page);
  await expect(page.getByText('Report Edit Tool')).toBeVisible();
  await expect(page.getByRole('link', { name: '編集' })).toHaveAttribute('aria-current', 'page');
  // 上部バー(一覧へ戻る)も同時に見える = 2 つの header が縦に並ぶ
  await expect(page.getByLabel('一覧へ戻る')).toBeVisible();
});

test('作成経路(?created=1)の編集画面は「テンプレート作成」タブが点灯する', async ({ page }) => {
  await login(page);
  await openEditor(page, '?created=1');
  await expect(page.getByRole('link', { name: 'テンプレート作成' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: '編集' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('編集画面はアプリヘッダの下の残り高さを全部使い、ページはスクロールしない', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await openEditor(page);
  const metrics = await page.evaluate(() => {
    const main = document.querySelector('main');
    const topBar = document.querySelector('header:has([aria-label="一覧へ戻る"])');
    const editorRoot = topBar?.parentElement;
    return {
      mainH: main?.getBoundingClientRect().height ?? -1,
      editorH: editorRoot?.getBoundingClientRect().height ?? -1,
      editorBottom: editorRoot?.getBoundingClientRect().bottom ?? -1,
      docScroll: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  expect(Math.abs(metrics.mainH - metrics.editorH)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.editorBottom - 900)).toBeLessThanOrEqual(1);
  expect(metrics.docScroll).toBeLessThanOrEqual(0);
});

test('プレビュー画面もタブの下に展開される', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`, { waitUntil: 'commit' });
  await expect(page.getByRole('link', { name: '編集' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('エディターに戻る')).toBeVisible();
});

test('他タブへ行って「編集」タブを押すと、編集中のテンプレートへ戻る', async ({ page }) => {
  await login(page);
  await openEditor(page);
  await page.getByRole('link', { name: '比較' }).click();
  await expect(page).toHaveURL(/\/compare$/);
  await page.getByRole('link', { name: '編集' }).click();
  await expect(page).toHaveURL(new RegExp(`/edit/${encodeURIComponent(SEED_ID)}$`));
  await page.frameLocator('iframe.gjs-frame').locator('.page').first().waitFor({ timeout: 30_000 });
});

test('一覧を見ていた状態から他タブへ行って「編集」タブを押すと、一覧へ戻る', async ({ page }) => {
  await login(page);
  await page.goto('/edit', { waitUntil: 'commit' });
  await page.getByRole('link', { name: '履歴' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await page.getByRole('link', { name: '編集' }).click();
  await expect(page).toHaveURL(/\/edit$/);
});
