// =============================================================================
// review_tab.spec.ts — 承認タブが対象テンプレートの申請を並べ、1 件ずつ決着できることの回帰網
// =============================================================================
// 対象の決め方(?template= → 編集タブの直前画面 → 空状態)、要約箱 3 つの件数、同時展開の上限、
// 決着後に同じ画面へ留まることを実機で固定する。
import { expect, type Locator, type Page, test } from '@playwright/test';
import { login, openEditor, submitOnce } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

test('対象が無ければ誘導し、編集タブで開いたテンプレートの申請を要約箱つきで並べる', async ({
  page,
}) => {
  await login(page, 'admin');
  await submitOnce(page, SEED_ID);
  await submitOnce(page, SEED_ID);

  await login(page, 'approver');
  await page.goto('/reviews');
  await expect(page.getByText('編集タブでテンプレートを開いてから')).toBeVisible();

  await openEditor(page, SEED_ID);
  await page.getByRole('link', { name: '承認' }).click();

  await expect(page.locator('[data-summary="pending"]')).toContainText('2');
  await expect(page.locator('[data-review-item]')).toHaveCount(2);
  // 先頭だけ展開されている
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(2);

  // 2 件目も開くと合計 4 面。上限 2 件なので 3 件目は無いが、両方開いた状態を確認する
  await page.locator('[data-review-toggle]').nth(1).click();
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(4);

  // 先頭を却下すると同じ画面に留まり、承認待ちが 1 件に減る
  const first = page.locator('[data-review-item]').first();
  await first.locator('textarea[id^="review-comment"]').fill('数値を確認してください');
  await first.getByRole('button', { name: '却下する' }).click();
  await expect(page).toHaveURL(/\/reviews/);
  await expect(page.locator('[data-summary="pending"]')).toContainText('1');
  await expect(page.locator('[data-summary="rejected"]')).toContainText('1');
  await expect(page.locator('[data-review-item]')).toHaveCount(1);
});

/**
 * canvas でパーツを選択し、右ペインのコメント欄から 1 件付ける
 * (`comment_panel.spec.ts` の `addComment` と同じ操作列)。右ペインを「コメント」タブへ
 * 切り替えるのは呼び出し側の責務(このファイルでは 1 回だけ切り替える)。
 * canvas 側のパーツ選択で計算する pathKey(`partKey.ts` の `canvasRawKey`)は確定版の生 HTML を
 * 静的パースする側(`ReviewTabView` の `partLabels`)と一致するので、通常の追加経路で付けた
 * コメントがそのまま承認タブから到達できる。
 */
async function addCanvasComment(page: Page, part: Locator, content: string): Promise<void> {
  await part.waitFor({ state: 'visible', timeout: 30_000 });
  await part.click();
  const input = page.getByPlaceholder('このパーツへのコメントを書く');
  await expect(input).toBeEnabled();
  await input.fill(content);
  await page.locator('button[data-add-submit]').click();
  await expect(page.locator('[data-comment-row]', { hasText: content })).toBeVisible();
}

/** `item`(承認タブの区画)内の見た目比較 iframe 2 枚(修正前/修正後)。 */
function comparePreviewFrames(item: Locator): { before: Locator; after: Locator } {
  const frames = item.frameLocator('iframe[title="プレビュー"]');
  return { before: frames.first(), after: frames.nth(1) };
}

/**
 * 見た目比較の両面が組版を終える(ページが実際に描画される)まで待つ。行クリック直後は
 * `ReviewDetail.pendingIndex` → `ReviewVisualCompare.pendingPageIndex` の待機経路を通ることが
 * あり、どちらの経路でも最終的にここまでは揃う。
 */
async function waitForComparePages(item: Locator): Promise<void> {
  const { before, after } = comparePreviewFrames(item);
  await before
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await after
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
}

test('承認タブの行クリックで見た目比較が該当ページ(2 ページ目)へ移動する', async ({ page }) => {
  // 2 ページ目先頭パーツ宛にコメントを 1 件用意して申請する(区画の内容自体は未編集でよい)。
  const COMMENT_TEXT = '2ページ目パーツへの確認コメント';
  await login(page, 'admin');
  await openEditor(page, SEED_ID);
  // 既定の 1 ページ表示では 2 ページ目が canvas 上で非表示(display:none)のまま。全ページ
  // 連続表示へ切り替えてから対象パーツを選ぶ。
  await page.getByRole('button', { name: '全ページを連続表示' }).click();
  await page.locator('[data-pane-tab="comments"]').click();
  const secondPagePart = page
    .frameLocator('iframe.gjs-frame')
    .locator('.page')
    .nth(1)
    .locator('> *')
    .first();
  await addCanvasComment(page, secondPagePart, COMMENT_TEXT);
  await submitOnce(page, SEED_ID);

  await login(page, 'approver');
  await openEditor(page, SEED_ID);
  await page.getByRole('link', { name: '承認' }).click();

  const item = page.locator('[data-review-item]').first();
  const row = item.locator('[data-comment-row]', { hasText: COMMENT_TEXT });
  await expect(row).toBeVisible();
  // 到達可能なコメントであることの前提確認(削除済みパーツ扱いなら行クリックは no-op)。
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  // `ReviewVisualCompare.vue` のテンプレートの改行由来で末尾に空白が付く(regex マッチは
  // 前後の空白を trim しないため `\s*` で吸収する)。
  const pageCounter = item.getByText(/^2 \/ \d+ ページ（左右連動）\s*$/);

  // 区画は開いた直後(=既定で先頭が展開済み)で、見た目比較の組版が終わっているとは限らない。
  // 未準備なら `ReviewDetail.pendingIndex` → `ReviewVisualCompare.pendingPageIndex` の待機を、
  // 準備済みなら `gotoPage` の即送信経路を通るが、いずれも収束先は同じ 2 ページ目。
  await row.click();
  await waitForComparePages(item);
  await expect(pageCounter).toBeVisible({ timeout: 15_000 });

  // 文字の変更を一覧で見るタブへ切り替えてから行を押すと、`ReviewVisualCompare` はこの間
  // `v-if` でアンマウントされ、再度の行クリックは必ず再マウント後の待機経路
  // (`ReviewDetail.pendingIndex` → `ReviewVisualCompare` 再マウント → `pendingPageIndex`)を
  // 通る — この 2 段の待機(単体網が無い)を固定する。
  await item.getByRole('button', { name: '文字の変更を一覧で見る' }).click();
  await expect(pageCounter).toHaveCount(0);

  await row.click();
  await waitForComparePages(item);
  await expect(pageCounter).toBeVisible({ timeout: 15_000 });
});
