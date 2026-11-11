// =============================================================================
// create_report.spec.ts — create_report.py 連携(新しい基準日で開く・単体 PDF)の回帰網
// =============================================================================
// e2e サーバは `REPORT_SCRIPT` を偽物 `server/scripts/fake_create_report.py` に向ける(本物は
// 遮断端末にしか無く、本物の dataRoot を書き換えうる)。偽物は起動のたびに
// `E2E_REPORT_CALL_LOG` へ 1 行足すので、「走らなかった」ことはその行数で確かめる。
// 元になるテンプレート(`templates/` の 3 つ区切り)は seed が空で始めるため、各テストで置く。
// 特別なファンドコードの意味は偽物の docstring を参照。
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_REPORT_CALL_LOG, E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import { finalizeReview, login, openReviewDetail, submitOnce } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
const filledDir = path.join(E2E_REST_DATA_ROOT, 'filled');

const SKELETON_BODY =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>e2e</title></head>' +
  '<body><section class="e2e-fill"><h1 class="report-title">e2e 生成</h1></section></body></html>';

/** 元になるテンプレート(会社 XX01・ファンド・版種)を `templates/` に置き、呼び出し記録を空にする。 */
function seedSkeleton(fund: string, edition: string): void {
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, `XX01_${fund}_${edition}.html`), SKELETON_BODY);
  fs.rmSync(E2E_REPORT_CALL_LOG, { force: true });
}

function callCount(): number {
  if (!fs.existsSync(E2E_REPORT_CALL_LOG)) {
    return 0;
  }
  return fs.readFileSync(E2E_REPORT_CALL_LOG, 'utf-8').split('\n').filter(Boolean).length;
}

/** 編集タブで「新しい基準日で開く」を開き、テンプレートと基準日を選ぶ。 */
async function pickSkeleton(page: Page, fund: string, edition: string, isoDate: string) {
  await login(page);
  await page.goto('/edit', { waitUntil: 'commit' });
  await page.getByRole('button', { name: '新しい基準日で開く' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select').selectOption({ label: `XX01 ${fund} ${edition}` });
  await dialog.locator('input[type=date]').fill(isoDate);
  return dialog;
}

test('opens new base date via create_report and lands on editor', async ({ page }) => {
  seedSkeleton('910024', '交付版');
  const dialog = await pickSkeleton(page, '910024', '交付版', '2026-11-10');
  await dialog.getByRole('button', { name: '開く' }).click();

  const id = 'XX01_910024_20261110_交付版';
  await expect(page).toHaveURL(/\/edit\//, { timeout: 30_000 });
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe(`/edit/${id}`);
  expect(new URL(page.url()).search).not.toContain('created=1');
  expect(fs.readFileSync(path.join(filledDir, `${id}.html`), 'utf-8')).toBe(SKELETON_BODY);
  expect(callCount()).toBe(1);
  await page
    .frameLocator('iframe.gjs-frame')
    .locator('.report-title')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
});

test('opens existing filled without running script', async ({ page }) => {
  // 既存の値入り HTML(fixtures の XX01_910024_20251117_全体版)と同じ基準日を指す。
  seedSkeleton('910024', '全体版');
  const id = 'XX01_910024_20251117_全体版';
  const before = fs.readFileSync(path.join(filledDir, `${id}.html`), 'utf-8');
  const dialog = await pickSkeleton(page, '910024', '全体版', '2025-11-17');
  await dialog.getByRole('button', { name: '開く' }).click();

  await expect(page).toHaveURL(/\/edit\//, { timeout: 30_000 });
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe(`/edit/${id}`);
  // 既にある値入り HTML は生成しない: スクリプトは 1 度も走らず、内容も変わらない。
  expect(callCount()).toBe(0);
  expect(fs.readFileSync(path.join(filledDir, `${id}.html`), 'utf-8')).toBe(before);
});

test('shows retry on failure fund 999101', async ({ page }) => {
  seedSkeleton('999101', '交付版');
  const dialog = await pickSkeleton(page, '999101', '交付版', '2026-11-10');
  await dialog.getByRole('button', { name: '開く' }).click();

  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('button', { name: '再試行' })).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe('/edit');
  expect(fs.existsSync(path.join(filledDir, 'XX01_999101_20261110_交付版.html'))).toBe(false);
});

test('downloads report pdf from preview', async ({ page }) => {
  seedSkeleton('910024', '全体版');
  await login(page);
  const id = 'XX01_910024_20251117_全体版';
  await page.goto(`/preview/${encodeURIComponent(id)}`, { waitUntil: 'commit' });

  // 状態の確定までボタンは押せない。有効になってから押す(トンボの切り替えは出ない)。
  const button = page.getByRole('button', { name: 'PDF出力' });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'トンボ' })).toHaveCount(0);
  const downloading = page.waitForEvent('download', { timeout: 60_000 });
  await button.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${id}.pdf`);
  const file = await download.path();
  expect(fs.readFileSync(file).subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  expect(callCount()).toBe(1);
});

const pdfDir = path.join(E2E_REST_DATA_ROOT, 'pdf');

test('approval builds the official pdf', async ({ page }) => {
  // 申請(submitOnce)は負荷下で 30 秒近くかかる。承認の結果通知まで待つので余裕を持たせる。
  test.setTimeout(180_000);
  const id = 'XX01_950037_20240710_交付版';
  seedSkeleton('950037', '交付版');
  await login(page, 'admin');
  await submitOnce(page, id);

  await login(page, 'approver');
  await openReviewDetail(page, id);
  const item = page.locator('[data-review-item]').first();
  await expect(item.locator('[data-decision-progress]')).toContainText('判定 0 / 0', {
    timeout: 60_000,
  });
  await finalizeReview(page, item);

  // 承認で正式 PDF を積み、組み終わったら結果を通知する。
  await expect(page.getByRole('status').filter({ hasText: '正式 PDF を作りました' })).toBeVisible({
    timeout: 60_000,
  });
  const pdf = path.join(pdfDir, `${id}.pdf`);
  expect(fs.readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('approver rebuilds the official pdf', async ({ page }) => {
  seedSkeleton('910024', '全体版');
  await login(page, 'approver');
  const id = 'XX01_910024_20251117_全体版';
  await page.goto(`/preview/${encodeURIComponent(id)}`, { waitUntil: 'commit' });

  const status = page.getByTestId('official-pdf-status');
  const rebuild = status.getByRole('button', { name: '正式 PDF を作り直す' });
  await expect(rebuild).toBeEnabled({ timeout: 60_000 });
  await rebuild.click();
  await expect(status).toContainText('できた', { timeout: 60_000 });
  expect(fs.existsSync(path.join(pdfDir, `${id}.pdf`))).toBe(true);
});
