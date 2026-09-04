// =============================================================================
// review_tab.spec.ts — 承認タブが対象テンプレートの申請を並べ、1 件ずつ決着できることの回帰網
// =============================================================================
// 対象の決め方(?template= → 編集タブの直前画面 → 空状態)、要約箱 3 つの件数、同時展開の上限、
// 決着後に同じ画面へ留まることを実機で固定する。
import { expect, type Page, test } from '@playwright/test';

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
 * `partKey.ts` の `rawKey`(`data-part-id` → 要素 `id` → 先頭 class → tag 名 の優先順)を
 * `id` を使わずに計算する。canvas(GrapesJS)は読み込むたびに全パーツへ揮発性の `id` を
 * 新規に振る(実測: 同一パーツでも再読み込みのたびに `id` が変わり、`editor.getHtml()` の
 * 出力にも残らない)。ゆえに canvas 経由でいま追加したコメントの pathKey は、確定版側
 * (`id` を持たない生 HTML を静的パースする `ReviewTabView` の `partLabels`)と噛み合わない
 * ことがある。このシード用テンプレートは `data-part-id` も持たないため、通常の追加経路
 * (`comment_panel.spec.ts` の `addComment`)ではこの不一致を避けられない — Task 8 の範囲外の
 * 既存挙動なので、ここでは静的パース側と同じ規則を自前で計算し、直接
 * `editor:notes:v2` へ投入することで「行クリックで到達できるコメント」を用意する。
 */
async function seedReachableComment(page: Page, content: string): Promise<void> {
  const info = await page
    .frameLocator('iframe.gjs-frame')
    .locator('body')
    .evaluate((body) => {
      function rawKey(el: Element): string {
        const partId = el.getAttribute('data-part-id');
        if (partId) return partId;
        const cls = el.classList[0];
        if (cls) return `.${cls}`;
        return el.tagName.toLowerCase();
      }
      function occurrenceKey(el: Element, siblings: Element[]): string {
        const base = rawKey(el);
        let n = 0;
        for (const s of siblings) {
          n += rawKey(s) === base ? 1 : 0;
          if (s === el) break;
        }
        return `${base}#${n}`;
      }
      const pages = Array.from(body.querySelectorAll('.page'));
      const page2 = pages[1];
      const parts = Array.from(page2.children);
      const target = parts[0];
      return { pathKey: `${occurrenceKey(page2, pages)}/${occurrenceKey(target, parts)}` };
    });
  await page.evaluate(
    ({ templateId, pathKey, content }) => {
      const KEY = 'editor:notes:v2';
      const store = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      const tpl = store[templateId] ?? {};
      const entries = tpl[pathKey] ?? [];
      entries.push({
        id: crypto.randomUUID(),
        templateId,
        pathKey,
        content,
        createdAt: new Date().toISOString(),
        createdBy: 'admin',
        updatedAt: null,
        updatedBy: null,
        status: 'open',
        replyTo: null,
        kind: 'note',
      });
      tpl[pathKey] = entries;
      store[templateId] = tpl;
      localStorage.setItem(KEY, JSON.stringify(store));
    },
    { templateId: SEED_ID, pathKey: info.pathKey, content },
  );
}

test('コメント行クリックは組版準備前でも見た目比較タブへ確実に戻す', async ({ page }) => {
  // 区画(申請)を 1 件持たせておく(内容は未編集のままでよい)。
  await login(page, 'admin', 'admin');
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await waitForCanvasReady(page);
  const COMMENT_TEXT = '2ページ目パーツへの確認コメント';
  await seedReachableComment(page, COMMENT_TEXT);
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

  // 区画は開いた直後(=既定で先頭が展開済み)で、見た目比較の組版が終わっているとは限らない。
  // Playwright の速度次第でここまでに組版が終わっていることもあり、その場合は
  // `ReviewVisualCompare.gotoPage` が即送信経路を、そうでなければ `ReviewDetail.pendingIndex`
  // 経由の保留経路を通る — どちらでも見た目比較タブ(既定)には留まるので、ページ番号表示
  // (見た目比較タブでしか描画されない `v-if="activeTab === 'visual'"`)が出ることだけを見る。
  await row.click();
  await expect(item.getByText(/ページ（左右連動）/)).toBeVisible();

  // 文字の変更を一覧で見るタブへ切り替えてから行を押すと、見た目比較タブへ戻る。
  // `ReviewVisualCompare` はこの間 `v-if` でアンマウントされているため、再度の行クリックは
  // 必ず再マウント後の保留経路(`ReviewDetail.pendingIndex` → `ReviewVisualCompare` 再マウント
  // → `pendingPageIndex`)を通る — この 2 段の保留(単体網が無い)を e2e で固定する。
  await item.getByRole('button', { name: '文字の変更を一覧で見る' }).click();
  await expect(item.getByText(/ページ（左右連動）/)).toHaveCount(0);

  await row.click();
  await expect(item.getByText(/ページ（左右連動）/)).toBeVisible();
});
