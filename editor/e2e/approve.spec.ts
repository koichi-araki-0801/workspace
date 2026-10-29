// =============================================================================
// approve.spec.ts — 承認タブの「最終確定する」が申請を決着させることの回帰網
// =============================================================================
// `review_tab.spec.ts` は申請ごとの却下を固定しているため、承認自体の決着
// (既定の絞り込みの承認待ちから外れ、承認済みバッジ + 承認者・日時の表示に変わる)を
// ここで押さえる。判定は右欄「変更と判定」の行で行い、保存(`/part-decisions`)の応答を待つ。
import fs from 'node:fs';
import path from 'node:path';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import {
  chipCount,
  decisionRow,
  finalizeReview,
  login,
  openReviewDetail,
  partDecisionsSaved,
  submitEditReviewViaApi,
  submitOnce,
} from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

test('承認タブの「最終確定する」で区画が決着済み表示に変わる', async ({ page }) => {
  // 申請(submitOnce)は負荷下で 30 秒近くかかり、既定のテスト timeout(30 秒)と競争になる。
  // 同じ申請を含む review_tab.spec.ts と同じ余裕を持たせる。
  test.setTimeout(120_000);
  await login(page, 'admin');
  await submitOnce(page, SEED_ID);

  await login(page, 'approver');
  await openReviewDetail(page, SEED_ID);

  await expect(chipCount(page, 'pending')).toHaveText('1');
  const item = page.locator('[data-review-item]').first();
  await expect(item).toBeVisible();
  // 未編集の申請は判定すべき変更パーツを持たない。右欄に行は無く、まとめて判定の帯は押せない。
  // 判定を挟まずに最終確定へ進める。
  await expect(item.locator('[data-decision-progress]')).toContainText('判定 0 / 0', {
    timeout: 60_000,
  });
  await expect(item.locator('[data-review-row-no]')).toHaveCount(0);
  await expect(item.locator('[data-review-pick-all]')).toBeDisabled();
  await finalizeReview(page, item);

  // 決着後は既定の絞り込み(承認待ち)からこの申請が外れ、チップの件数が動く。
  await expect(chipCount(page, 'pending')).toHaveText('0');
  await expect(chipCount(page, 'approved')).toHaveText('1');
  await expect(page.locator('[data-review-item]')).toHaveCount(0);

  // 「承認済み」のチップを押すと決着済み表示(承認済みバッジ + 承認者・日時)で 1 件出る。
  await page.locator('[data-review-chip="approved"]').click();
  const decided = page.locator('[data-review-item]').first();
  await expect(decided).toContainText('承認済み');
  await expect(decided).toContainText('approver'); // `reviewedBy` は表示名でなくログインID
});

test('パーツの判定は右欄の行で行い、保存の応答のあとで最終確定できる', async ({ page }) => {
  test.setTimeout(120_000);
  const html = fs
    .readFileSync(path.join(E2E_REST_DATA_ROOT, 'filled', `${SEED_ID}.html`), 'utf8')
    .replace('受益者のみなさまへ', '受益者の皆様へ');
  const css = fs.readFileSync(
    path.join(E2E_REST_DATA_ROOT, 'css', 'XX01_950037_交付版.css'),
    'utf8',
  );
  await login(page, 'editor');
  await submitEditReviewViaApi(page, { templateId: SEED_ID, html, css });

  await login(page, 'approver');
  await openReviewDetail(page, SEED_ID);
  const item = page.locator('[data-review-item]').first();
  const row = decisionRow(item, 1);
  await expect(row).toContainText('皆様', { timeout: 60_000 });
  const finalize = item.locator('[data-decision-bar] [data-finalize]');
  await expect(finalize).toBeDisabled();

  const saved = partDecisionsSaved(page);
  await row.getByRole('button', { name: '承認', exact: true }).click();
  await saved;
  await expect(row.locator('[data-review-no]')).toHaveAttribute('data-decision', 'approved');
  await expect(item.locator('[data-decision-progress]')).toContainText('判定 1 / 1');
  await finalizeReview(page, item);
  await expect(chipCount(page, 'approved')).toHaveText('1', { timeout: 30_000 });
  expect(
    fs.readFileSync(path.join(E2E_REST_DATA_ROOT, 'filled', `${SEED_ID}.html`), 'utf8'),
  ).toContain('受益者の皆様へ');
});
