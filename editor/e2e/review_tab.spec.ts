// =============================================================================
// review_tab.spec.ts — 承認タブが対象テンプレートの申請を並べ、1 件ずつ決着できることの回帰網
// =============================================================================
// 対象の決め方(?template= → 編集タブの直前画面 → 空状態)、要約箱 3 つの件数、同時展開の上限、
// 決着後に同じ画面へ留まることを実機で固定する。
import { expect, type Locator, type Page, test } from '@playwright/test';

const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page, user: string, pass: string): Promise<void> {
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(pass);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  // `nav` はロール非依存で全ロールに出るアプリヘッダの一部(`MainLayout.vue`)。着地後の
  // レンダリングを待つのに固定待ちより確実。
  await page.locator('header nav a').first().waitFor();
}

async function submitOnce(page: Page): Promise<void> {
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  // `submitOnce` の先頭で `goto` するので前回の toast は残らない(`PreviewView.toastSuccess`、
  // `Toaster.vue` は `role="status"`)。
  await expect(
    page.getByRole('status').filter({ hasText: '確定保存を申請しました' }),
  ).toBeVisible();
}

/** GrapesJS canvas 初期化完了(1 ページ目が描画済み)を待つ。`/edit/:id` 遷移直後の固定待みの
 * 置き換え。`tabbed_layout.spec.ts` の `openEditor` と同じロケータを使う。 */
async function waitForCanvasReady(page: Page): Promise<void> {
  await page
    .frameLocator('iframe.gjs-frame')
    .locator('.page')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
}

test('対象が無ければ誘導し、編集タブで開いたテンプレートの申請を要約箱つきで並べる', async ({
  page,
}) => {
  await login(page, 'admin', 'admin');
  await submitOnce(page);
  await submitOnce(page);

  await login(page, 'approver', 'approver');
  await page.goto('/reviews');
  await expect(page.getByText('編集タブでテンプレートを開いてから')).toBeVisible();

  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await waitForCanvasReady(page);
  await page.getByRole('link', { name: '承認' }).click();

  await expect(page.locator('[data-summary="pending"]')).toContainText('2');
  await expect(page.locator('[data-review-item]')).toHaveCount(2);
  // 先頭だけ展開されている
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(2);

  // 2 件目も開くと合計 4 面。上限 2 件なので 3 件目は無いが、両方開いた状態を確認する
  await page.locator('[data-review-toggle]').nth(1).click();
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(4);

  // 先頭を差し戻すと同じ画面に留まり、承認待ちが 1 件に減る
  const first = page.locator('[data-review-item]').first();
  await first.locator('textarea[id^="review-comment"]').fill('数値を確認してください');
  await first.getByRole('button', { name: '差し戻す' }).click();
  await expect(page).toHaveURL(/\/reviews/);
  await expect(page.locator('[data-summary="pending"]')).toContainText('1');
  await expect(page.locator('[data-summary="rejected"]')).toContainText('1');
  await expect(page.locator('[data-review-item]')).toHaveCount(1);
});

/**
 * canvas でパーツを選択し、右ペインのコメント欄から 1 件付ける
 * (`comment_panel.spec.ts` の `addComment` と同じ操作列)。右ペインを「コメント」タブへ
 * 切り替えるのは呼び出し側の責務(このファイルでは 1 回だけ切り替える)。
 * `partKey.ts` の `canvasRawKey` 導入(事象 B の修正)により、canvas 側のパーツ選択で計算する
 * pathKey は確定版の生 HTML を静的パースする側(`ReviewTabView` の `partLabels`)と一致する
 * ようになったため、通常の追加経路で付けたコメントがそのまま承認タブから到達できる。
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
 * `ReviewDetail.pendingIndex` → `ReviewVisualCompare.pendingPageIndex` の保留経路を通ることが
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
  await login(page, 'admin', 'admin');
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await waitForCanvasReady(page);
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
  await submitOnce(page);

  await login(page, 'approver', 'approver');
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await waitForCanvasReady(page);
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
  // 未準備なら `ReviewDetail.pendingIndex` → `ReviewVisualCompare.pendingPageIndex` の保留を、
  // 準備済みなら `gotoPage` の即送信経路を通るが、いずれも収束先は同じ 2 ページ目。
  await row.click();
  await waitForComparePages(item);
  await expect(pageCounter).toBeVisible({ timeout: 15_000 });

  // 文字の変更を一覧で見るタブへ切り替えてから行を押すと、`ReviewVisualCompare` はこの間
  // `v-if` でアンマウントされ、再度の行クリックは必ず再マウント後の保留経路
  // (`ReviewDetail.pendingIndex` → `ReviewVisualCompare` 再マウント → `pendingPageIndex`)を
  // 通る — この 2 段の保留(単体網が無い)を固定する。
  await item.getByRole('button', { name: '文字の変更を一覧で見る' }).click();
  await expect(pageCounter).toHaveCount(0);

  await row.click();
  await waitForComparePages(item);
  await expect(pageCounter).toBeVisible({ timeout: 15_000 });
});
