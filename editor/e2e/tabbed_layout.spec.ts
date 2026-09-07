// =============================================================================
// tabbed_layout.spec.ts — 編集・プレビュー画面がタブの下に展開されること
// =============================================================================
// 編集・プレビューは MainLayout の子ルートで、アプリヘッダとタブが常に見える。編集画面は
// 残りの高さを全部使う(`h-full`)。タブを押すと、そのタブで直前に見ていた画面へ戻る。
import { expect, type Page, test } from '@playwright/test';
import { login, openEditor as openEditorAt } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';

// 編集後に reload するテストがある。dirty な編集画面は閉じる前の警告(`beforeunload`)を出し、
// Playwright はリスナ無しのダイアログを dismiss(= ページに留まる)するため、reload が止まる。
// 警告は accept して進める(ここで検証したいのは警告でなく、その後の復元・破棄の挙動)。
test.beforeEach(({ page }) => {
  page.on('dialog', (d) => void d.accept());
});

const openEditor = (page: Page, query = '') => openEditorAt(page, SEED_ID, query);

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

/**
 * 編集を許可して地の段落へ 1 語追記し、autosave の完了を待つ。RTE の活性化は dblclick だが、
 * Playwright の合成ダブルクリックは選択後に出る GrapesJS のオーバーレイに 2 打目を吸われて
 * 発火しない(実測)ので、canvas 文書へ直接 dblclick を配送する(`smoke.spec.ts` と同じ)。
 */
async function appendAndAutosave(page: Page, text: string) {
  const frame = page.frameLocator('iframe.gjs-frame');
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  await frame.getByText('受益者のみなさまへ').first().click();
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes('受益者のみなさまへ'),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el, t) => {
    el.append(t);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, text);
  await frame
    .locator('.page')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await expect(frame.getByText(text).first()).toBeVisible({ timeout: 10_000 });
  // 文言は 2xl 未満で隠れるので、全文を持つ title で autosave 完了を待つ
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });
}

test('未確定の編集があっても他タブへ行ける(破棄確認は出ない)し、戻ると編集が残っている', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  await openEditor(page);
  await appendAndAutosave(page, 'E2Eタブ往復');

  await page.getByRole('link', { name: '比較' }).click();
  await expect(page).toHaveURL(/\/compare$/);
  await expect(page.getByText('保存していない変更があります')).toHaveCount(0);

  await page.getByRole('link', { name: '編集' }).click();
  const frame = page.frameLocator('iframe.gjs-frame');
  await expect(frame.getByText('E2Eタブ往復').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('未確定', { exact: true })).toBeVisible();
});

test('リロードでは編集が残る(同じタブ = 同じセッション)', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await openEditor(page);
  await appendAndAutosave(page, 'E2Eリロード');
  await page.reload({ waitUntil: 'commit' });
  const frame = page.frameLocator('iframe.gjs-frame');
  await expect(frame.getByText('E2Eリロード').first()).toBeVisible({ timeout: 30_000 });
});

test('タブを閉じた後(セッショントークンが消えた後)に開き直すと、未確定の編集は破棄される', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await login(page);
  await openEditor(page);
  await appendAndAutosave(page, 'E2E破棄');
  // ブラウザタブを閉じて開き直す = 同じ context に新しいページを開く(sessionStorage は
  // 新規発行・localStorage は共有)。`sessionStorage.clear()` + `reload` では、旧ページの
  // `visibilitychange`(reload 中に発火する)で保留中の autosave が flush され、その成功時に
  // `owner.claim` が新トークンを空になった sessionStorage へ鋳造してしまうため「同じタブ」を
  // 装えず偽陽性(下書きが破棄されない)を招く。ページを閉じて新規ページで開き直すことで、
  // 旧ページの flush が新ページの sessionStorage に触れないようにする。
  const url = page.url();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(url, { waitUntil: 'commit' });
  const frame = reopened.frameLocator('iframe.gjs-frame');
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(frame.getByText('E2E破棄')).toHaveCount(0);
  await expect(reopened.getByText('変更なし', { exact: true })).toBeVisible();
  // 下書きの実体(local モードは localStorage の `editor:drafts`)も消えている
  const leftover = await reopened.evaluate(() =>
    (localStorage.getItem('editor:drafts') ?? '').includes('E2E破棄'),
  );
  expect(leftover).toBe(false);
  // Undo で破棄した本文が戻らない(ミラーから復元した Undo スタックも捨てている)。
  await expect(reopened.getByRole('button', { name: '元に戻す' })).toBeDisabled();
});
