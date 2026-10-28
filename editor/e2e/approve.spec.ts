// =============================================================================
// approve.spec.ts — 承認タブの「最終確定する」が申請を決着させることの回帰網
// =============================================================================
// `review_tab.spec.ts` は却下(差し戻し)のみを固定しているため、承認自体の決着
// (既定フィルタの承認待ちから外れ、承認済みバッジ + 承認者・日時の表示に変わる)を
// ここで押さえる。
import { expect, test } from './fixtures';
import { finalizeReview, login, openReviewDetail, submitOnce } from './helpers';

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

  await expect(page.locator('[data-summary="pending"] .text-2xl')).toHaveText('1');
  const item = page.locator('[data-review-item]').first();
  await expect(item).toBeVisible();
  // 未編集の申請は判定すべき変更パーツを持たない。一括承認はタブ内では押せず、決着箱には
  // 出ない。判定を挟まずに最終確定へ進める。
  await expect(
    item.locator('[data-review-decision]').getByRole('button', { name: '未判定を一括承認' }),
  ).toHaveCount(0);
  await item.getByRole('button', { name: '文字の変更を一覧で見る' }).click();
  await expect(item.getByText('判定: 承認待ち 0 件')).toBeVisible();
  await expect(item.getByRole('button', { name: '未判定を一括承認' })).toBeDisabled();
  await finalizeReview(page, item);

  // 決着後は既定フィルタ(承認待ち)からこの申請が外れ、要約箱の件数が動く。
  await expect(page.locator('[data-summary="pending"] .text-2xl')).toHaveText('0');
  await expect(page.locator('[data-summary="approved"] .text-2xl')).toHaveText('1');
  await expect(page.locator('[data-review-item]')).toHaveCount(0);

  // 「承認済み」の箱を押すと決着済み表示(承認済みバッジ + 承認者・日時)で 1 件出る。
  await page.locator('[data-summary="approved"]').click();
  const decided = page.locator('[data-review-item]').first();
  await expect(decided).toContainText('承認済み');
  await expect(decided).toContainText('approver'); // `reviewedBy` は表示名でなくログインID
});
