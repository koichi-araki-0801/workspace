// =============================================================================
// approval.rest.spec.ts — rest 経路(sproc フェイク + 一時 dataRoot)の申請→承認の実機検証
// =============================================================================
// `E2E_REST=1` のときだけ走る project `rest` 専用 spec。実 `POST /api/auth/login` の
// セッション cookie でログインし、一覧 → 編集 → 申請 → 承認 と進めたうえで、dataRoot の
// 確定ファイルと git コミットまでを実ディスクで確かめる。local project(localStorage +
// fixtures)では確定ファイルも git も存在しないため、この後段はここでしか検証できない。
//
// rest では `filled`(per-fund 値埋め込み済み HTML)が空で、編集 canvas は共通 sample の
// 差込表示になる。よって per-fund 実値のアサーションは書かず、canvas に本文が描かれること
// だけを見る。編集の材料に使う `受益者のみなさまへ` は fixture テンプレの地の文なので、
// 差込の有無に関わらず出る。
//
// ユーザー切替は `test()` を分けて行う。Playwright は `test()` ごとに cookie 空の
// `BrowserContext` を払い出すので、セッション cookie 方式の rest ではこれが最も素直な
// 切替手段になる(`review_tab.spec.ts` の 1 テスト内切替は localStorage 方式の local 専用)。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { login, openEditor, waitForLoaded } from './helpers';

const SEED_ID = 'AM01_510037_20240710_交付版';
const EDIT_MARK = 'restE2E追記';

// 2 つ目のテストは 1 つ目が残した申請を承認する。依存を実行順序として明示する。
test.describe.configure({ mode: 'serial' });

// 編集画面ヘッダは狭い幅だと保存状態の文言・ボタンが折り返す(`EditorTopBar.vue`)。
// 他の承認系 spec と同じ幅に揃える。
test.use({ viewport: { width: 1440, height: 900 } });

test('editor がログインして一覧・編集画面を確認し、確定保存を申請する', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'editor');
  // rest のセッションはサーバ発行の cookie。実 `POST /api/auth/login` が `Set-Cookie` を
  // 返したことをここで押さえる(local project は localStorage 方式なのでこの検証を持てない)。
  expect((await page.context().cookies()).map((c) => c.name)).toContain('editor.sid');

  // 一覧は条件を選んで検索するまで出ない。絞り込みは URL クエリと双方向同期する
  // (`useUrlQuerySync.ts`)ので、委託会社コードを URL で渡して復元経路から一覧を出す。
  await page.goto('/edit?companyCode=AM01', { waitUntil: 'commit' });
  // ファンド名はファンドマスタの有無に依存するので、常に描かれるファンドコード・基準日・
  // 版種の 3 列だけで 1 行に絞る。
  const row = page
    .locator('table tr', { hasText: '510037' })
    .filter({ hasText: '20240710' })
    .filter({ hasText: '交付版' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await waitForLoaded(page);

  const frame = await openEditor(page, SEED_ID);

  // 地の文へ 1 語追記する(承認後に確定ファイルへ反映されたことを確かめる材料)。RTE の
  // 活性化に canvas 文書へ直接 dblclick を配送するのは `smoke.spec.ts` と同じ理由で、
  // 合成ダブルクリックの 2 打目が GrapesJS のオーバーレイに吸われるため。
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
  await editing.evaluate((el, mark) => {
    el.append(mark);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, EDIT_MARK);
  await frame
    .locator('.page')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await expect(frame.getByText(EDIT_MARK).first()).toBeVisible({ timeout: 10_000 });
  // autosave(debounce)の完了を待つ。draft が無いと申請本文に追記が乗らない。文言は 2xl 未満で
  // 隠れるため、可視ではなく全文を持つ `title` 属性を見る。
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });

  // 申請はプレビュー画面から行う。`helpers.ts` の `submitOnce` を使わないのは、dirty な編集
  // 画面からの離脱に `beforeunload` の accept と `waitUntil: 'commit'` が要るため
  // (既定の `'load'` は SPA の起動時リダイレクトに割り込まれて `net::ERR_ABORTED` になる)。
  page.on('dialog', (d) => void d.accept());
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`, { waitUntil: 'commit' });
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await expect(page.getByRole('status').filter({ hasText: '確定保存を申請しました' })).toBeVisible({
    timeout: 30_000,
  });
});

test('approver が承認すると確定ファイルと git コミットへ反映される', async ({ page }) => {
  test.setTimeout(180_000);
  // 申請者(editor)とは別ユーザーで入る。自己承認は職務分掌で拒否される。
  await login(page, 'approver');

  // 承認タブの対象は「編集タブで開いているテンプレート」なので、先に編集画面を開く。
  await openEditor(page, SEED_ID);
  await page.getByRole('link', { name: '承認' }).click();

  await expect(page.locator('[data-summary="pending"] .text-2xl')).toHaveText('1');
  const item = page.locator('[data-review-item]').first();
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: '承認する' }).click();

  // 決着すると既定フィルタ(承認待ち)から外れる。承認済みの箱へ絞って決着表示を確かめる。
  await expect(page.locator('[data-summary="pending"] .text-2xl')).toHaveText('0', {
    timeout: 30_000,
  });
  await page.locator('[data-summary="approved"]').click();
  const decided = page.locator('[data-review-item]').first();
  await expect(decided).toContainText('承認済み');
  await expect(decided).toContainText('approver');

  // dataRoot の確定ファイルへ反映されたことを実ディスクで確認する。
  const html = fs.readFileSync(
    path.join(E2E_REST_DATA_ROOT, 'templates', `${SEED_ID}.html`),
    'utf8',
  );
  expect(html).toContain(EDIT_MARK);

  // 承認コミット(申請者=editor・承認者=approver)が積まれたことを確認する。HEAD 1 件では
  // なく履歴全体を見るのは、承認の完結後にペア同期がベストエフォートで別コミットを積みうる
  // ため(`pairSyncService.ts` の `syncPairAfterConfirm`)。
  const log = execFileSync('git', ['-C', E2E_REST_DATA_ROOT, 'log', '--format=%s'], {
    encoding: 'utf8',
  });
  expect(log).toContain(`確定保存(承認): ${SEED_ID} 申請=editor 承認=approver`);
});
