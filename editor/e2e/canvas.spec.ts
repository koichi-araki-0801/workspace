// =============================================================================
// canvas.spec.ts — GrapesJS canvas 統合の E2E(2 系統ハイライト / ズーム / ページ境界)
// =============================================================================
// `useGrapes.ts` の composable 分割(リファクタ)に先行して、単体テストが届かない
// GrapesJS 統合部の実画面挙動を固定する。2 系統の出し分けは `twoSystems.guard.test.ts`
// (単体)の実画面版 — canvas body の `jinja-vars-highlight` クラスまで確認する。

import { expect, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
}

/** 編集画面を開き、GrapesJS canvas のページ描画まで待つ。 */
async function openEditor(page: Page, query = '') {
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}${query}`);
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(600); // load 後の rAF(fitToView / ハイライト再適用)を待つ
  return frame;
}

test('編集 2 系統: 編集タブはハイライト無し / 作成経路(?created=1)は有り', async ({ page }) => {
  await login(page);

  // 編集経路(query なし) = per-fund 実値。差し込み値ハイライトは出さない。
  const editFrame = await openEditor(page);
  await expect(editFrame.locator('body')).not.toHaveClass(/jinja-vars-highlight/);

  // 作成経路(?created=1) = 共通 sample の表示のみ値入り。ハイライトを出す。
  const createFrame = await openEditor(page, '?created=1');
  await expect(createFrame.locator('body')).toHaveClass(/jinja-vars-highlight/);
});

test('ズーム: 拡大で canvas 倍率が変わり「画面に合わせる」でフィット倍率へ戻る', async ({
  page,
}) => {
  await login(page);
  await openEditor(page);

  // 倍率は iframe の表示幅で観測する (GrapesJS の zoom は inline transform に現れない)
  const widthOf = async () => (await page.locator('iframe.gjs-frame').boundingBox())?.width ?? 0;
  const fitted = await widthOf();
  expect(fitted).toBeGreaterThan(0);

  await page.getByRole('button', { name: '拡大' }).click();
  await page.waitForTimeout(400);
  expect(await widthOf()).toBeGreaterThan(fitted + 10);

  await page.getByRole('button', { name: '画面に合わせる' }).click();
  await page.waitForTimeout(400);
  expect(Math.abs((await widthOf()) - fitted)).toBeLessThan(2);
});

test('ページ境界 guide: 全ページ連続表示で「ここまで N ページ目」線が出る', async ({ page }) => {
  await login(page);
  await openEditor(page);

  // 既定は 1 ページ表示で guide は出ない
  await expect(page.locator('.pg-line')).toHaveCount(0);

  // 全ページ連続表示へ切替えると、page break 位置に guide 線が引かれる
  // (guide は setSinglePageMode の rAF → refreshPageGuides で非同期に測られるため長めに待つ)
  await page.getByRole('button', { name: '全ページを連続表示' }).click();
  const lines = page.locator('.pg-line');
  await expect(lines.first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('ここまで 1ページ目')).toBeVisible();

  // 上部バーからページ境界を隠すと guide が消える
  await page.getByRole('button', { name: 'ページ境界を隠す' }).click();
  await expect(page.locator('.pg-line')).toHaveCount(0);
});
