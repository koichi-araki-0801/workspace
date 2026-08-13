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

/**
 * 編集画面を開き、GrapesJS canvas のページ描画まで待つ。
 *
 * `goto` の完了条件は `'commit'` にする。既定の `'load'` は全サブリソースの読み込み完了まで
 * 待つため、SPA が起動時に出す認証確認や router のリダイレクトが割り込むと
 * **`net::ERR_ABORTED` で goto 自体が失敗する**(負荷の高い CI で実際に踏んだ)。
 * この関数が本当に待ちたいのは「canvas にページが描かれたか」で、それは下の
 * `waitFor` が直接見ている。
 */
async function openEditor(page: Page, query = '') {
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}${query}`, { waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  return frame;
}

test('編集 2 系統: 編集タブはハイライト無し / 作成経路(?created=1)は有り', async ({ page }) => {
  await login(page);

  // 編集経路(query なし) = per-fund 実値。差し込み値ハイライトは出さない。
  const editFrame = await openEditor(page);
  // 状態はマウント後の rAF で決まるので、固定待ちではなく条件が満たされるまで待つ。
  await expect(editFrame.locator('body')).not.toHaveClass(/jinja-vars-highlight/, {
    timeout: 15_000,
  });

  // 作成経路(?created=1) = 共通 sample の表示のみ値入り。ハイライトを出す。
  const createFrame = await openEditor(page, '?created=1');
  await expect(createFrame.locator('body')).toHaveClass(/jinja-vars-highlight/, {
    timeout: 15_000,
  });
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

  // 倍率の反映は rAF 経由なので、固定待ちだと負荷の高い CI で「まだ変わっていない」瞬間を
  // 掴んで落ちる(実際に fitted と同値のまま失敗した)。**条件が満たされるまで待つ**形にする。
  await page.getByRole('button', { name: '拡大' }).click();
  await expect.poll(widthOf, { timeout: 15_000 }).toBeGreaterThan(fitted + 10);

  await page.getByRole('button', { name: '画面に合わせる' }).click();
  await expect
    .poll(async () => Math.abs((await widthOf()) - fitted), { timeout: 15_000 })
    .toBeLessThan(2);
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
