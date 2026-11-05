// =============================================================================
// create_review.spec.ts — 作成経路の申請を、サーバが描いた本文で承認し、templates/ へ確定する回帰網
// =============================================================================
// 作成経路(?created=1)の承認画面は、サーバが受付で Jinja 原文から描いた本文(`renderedHtml`)だけを
// 見せる(申請者が送る値入り HTML は使わない。`server/src/repositories/reviewRepo.ts`)。ここでは
// 作成タブで生成 → 地の文を直す → 申請 → 承認者が承認タブで開くと紙面に直した文言が出る → 最終確定で
// templates/ に書かれる、までを実画面で通す。組み立て(`assemblePreviewDocument`)を外したことで紙面が
// 崩れていないかは、紙面のスクリーンショットを添付して目で確かめる(画素の比較はしない)。
import fs from 'node:fs';
import path from 'node:path';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import {
  approvePendingParts,
  chipCount,
  comparePapers,
  finalizeReview,
  login,
  openReviewDetail,
  partLocator,
} from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const ID = 'XX01_950037_交付版';
const EDIT_MARK = '（承認で確かめる追記）';
/** 偽の生成器(`server/scripts/fake_generate_template.py`)のスケルトンの地の文。 */
const META_TEXT = '委託会社: XX01';

test('作成経路: 生成して地の文を直して申請すると、承認タブの紙面に直した文言が出て、最終確定で templates/ に書かれる', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await login(page, 'editor');

  // 0. 受付は作成タブと同じ sample で描く。e2e のサーバ(sproc の偽物)が sample に応えること。
  const sample = await page.request.get(`/api/templates/${encodeURIComponent(ID)}/sample-data`);
  expect(sample.ok(), `GET sample-data ${sample.status()}`).toBeTruthy();

  // 1. 作成タブで交付版だけを作る(編集画面へ遷移する)。
  await page.goto('/create', { waitUntil: 'commit' });
  await page.getByText('作成するファンドを指定').first().waitFor();
  await page.getByPlaceholder('委託会社を入力/選択').click();
  await page.getByRole('option', { name: /^XX01（/ }).click();
  await page.getByPlaceholder('ファンドを入力/選択').click();
  await page.getByRole('option', { name: /^950037/ }).click();
  await page.getByRole('combobox').filter({ hasText: '選ばない（両版を作る）' }).click();
  await page.getByRole('option', { name: '交付版', exact: true }).click();
  await page.getByRole('button', { name: '属性から新規作成' }).click();
  await expect(page).toHaveURL(/\/edit\/.+\?created=1$/);
  const frame = page.frameLocator('iframe.gjs-frame');
  await frame.locator('.report-title').first().waitFor({ state: 'visible', timeout: 30_000 });

  // 2. 地の文へ追記する(RTE の活性化は canvas 文書へ直接 dblclick を配送する。`approval.spec.ts`
  //    と同じ理由)。
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  await frame.getByText(META_TEXT).first().click();
  await page.evaluate((needle) => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes(needle),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, META_TEXT);
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate((el, mark) => {
    el.append(mark);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, EDIT_MARK);
  await partLocator(frame)
    .first()
    .click({ position: { x: 5, y: 5 } });
  await expect(frame.getByText(EDIT_MARK).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });

  // 3. 作成経路のプレビュー(?created=1)から申請する。値入り HTML は送らない。
  page.on('dialog', (d) => void d.accept());
  const submitted = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/api\/review-requests$/.test(r.url()),
    { timeout: 120_000 },
  );
  await page.goto(`/preview/${encodeURIComponent(ID)}?created=1`, { waitUntil: 'commit' });
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  const body = (await submitted).postDataJSON() as Record<string, unknown>;
  expect(body.origin).toBe('create');
  expect(body).not.toHaveProperty('filledHtml');
  await expect(page.getByRole('status').filter({ hasText: '確定保存を申請しました' })).toBeVisible({
    timeout: 90_000,
  });

  // 4. 承認者が承認タブで開くと、紙面(サーバが描いた本文)に直した文言が出る。
  await login(page, 'approver');
  await openReviewDetail(page, ID);
  await expect(chipCount(page, 'pending')).toHaveText('1');
  const item = page.locator('[data-review-item]').first();
  await expect(item.locator('[data-review-row-no]').first()).toBeVisible({ timeout: 60_000 });
  const after = item.locator('[data-side="after"]');
  const paper = comparePapers(item).after;
  await paper
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await expect(paper.getByText(EDIT_MARK).first()).toBeVisible({ timeout: 30_000 });
  // 見出しも描いた値で出る(値の差し込みが紙面に届いている)。原文の `{{` は残らない。
  await expect(paper.locator('.report-title').first()).not.toContainText('{{');
  // 全部の枝を描いたことは、注意の帯に常に 1 文で出る。
  await expect(item.locator('[data-notice-branches]')).toBeVisible();
  const shot = testInfo.outputPath('create-review-paper.png');
  await after.screenshot({ path: shot });
  await testInfo.attach('作成経路の承認画面の紙面', { path: shot, contentType: 'image/png' });

  // 5. 判定して最終確定すると、Jinja 原文(直した文言を含む)が templates/ に書かれる。
  await approvePendingParts(page, item);
  await finalizeReview(page, item);
  await expect(chipCount(page, 'pending')).toHaveText('0', { timeout: 30_000 });
  const written = fs.readFileSync(path.join(E2E_REST_DATA_ROOT, 'templates', `${ID}.html`), 'utf8');
  expect(written).toContain(EDIT_MARK);
  expect(written).toContain('{{ fund.name }}');
});
