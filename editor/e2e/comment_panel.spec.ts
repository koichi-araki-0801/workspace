// =============================================================================
// comment_panel.spec.ts — 右ペインのコメント一覧が検索・絞り込み・パーツ移動を実際に行うことの回帰網
// =============================================================================
// 一覧は右ペイン(overlay 層の外)にあるので pointer-events の罠は無いが、行クリックが
// GrapesJS の選択と 1 ページ表示のページ送りまで届くかは実機でしか分からない。ここで押さえる。
import { expect, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  await page.waitForTimeout(800);
}

async function addComment(page: Page, partIndex: number, text: string): Promise<void> {
  const frame = page.frameLocator('iframe.gjs-frame');
  const part = frame.locator('.page > *').nth(partIndex);
  await part.waitFor({ state: 'visible', timeout: 30_000 });
  await part.click();
  await page.waitForTimeout(600);
  await page.getByPlaceholder('このパーツへのコメントを書く').fill(text);
  await page.locator('button[data-add-submit]').click();
  await page.waitForTimeout(800);
}

test('コメント一覧は検索・状態で絞り込め、行クリックでパーツを選択する', async ({ page }) => {
  await login(page);
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(3000);
  await page.locator('[data-pane-tab="comments"]').click();

  // 吹き出しはページへ常に重ねて出る仕様(表計算ソフトのセルコメントと同じ)なので、直前に
  // 開いた吹き出しがすぐ下のパーツを覆い、そこへのクリックを吸収してしまう。2 件目は
  // 1 件目より前方(canvas 上で上側)の index を選び、吹き出しの被覆を避ける。
  await addComment(page, 4, '表紙の日付');
  await addComment(page, 1, '要約の数値');

  const rows = page.locator('[data-comment-row]');
  await expect(rows).toHaveCount(2);

  await page.getByLabel('コメントを検索').fill('数値');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('要約の数値');
  await page.getByLabel('コメントを検索').fill('');

  // 1 件目を解決すると既定(未対応)の一覧から消え、「すべて」で戻る。
  await rows.filter({ hasText: '表紙の日付' }).locator('[data-expand]').click();
  await page.locator('[data-resolve]').click();
  await page.waitForTimeout(800);
  await expect(rows).toHaveCount(1);
  await page.locator('[data-filter-status]').selectOption('all');
  await expect(rows).toHaveCount(2);

  // 展開中の行は本文欄が `@click.stop` を持つ(返信・解決ボタンの誤発火防止)ため、行クリックの
  // 判定領域は畳んでからでないと押せる範囲がヘッダだけに狭まる。ここで畳んでおく。
  await rows.filter({ hasText: '表紙の日付' }).locator('[data-expand]').click();
  await page.waitForTimeout(300);

  // 行クリックで別パーツが選択され、吹き出しがそのパーツのスレッドを出す。
  await rows.filter({ hasText: '表紙の日付' }).click();
  await page.waitForTimeout(800);
  await expect(page.locator('.note-bubble')).toContainText('表紙の日付');
  await expect(page.locator('.note-bubble')).not.toContainText('要約の数値');
});
