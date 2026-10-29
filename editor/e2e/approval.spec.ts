// =============================================================================
// approval.spec.ts — 申請→承認の実機検証(サーバは sproc フェイク + 一時 dataRoot)
// =============================================================================
// chromium project で走る。実 `POST /api/auth/login` のセッション cookie でログインし、
// 一覧 → 編集 → 申請 → 承認 と進めたうえで、dataRoot の確定ファイルと git コミットまでを
// 実ディスクで確かめる。後半は承認タブの申請カード(左右の紙面・右欄「変更と判定」・判定バー)の
// 操作を 1 つずつ固定する。
//
// 編集 canvas は `filled/` に seed した値入り HTML を表示する。編集の材料に使う
// `受益者のみなさまへ` は fixture テンプレの地の文なので、差込の有無に関わらず出る。
//
// ユーザー切替は `test()` を分けて行う。Playwright は `test()` ごとに cookie 空の
// `BrowserContext` を払い出すので、セッション cookie 方式ではこれが最も素直な切替手段になる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import {
  approvePendingParts,
  chipCount,
  comparePapers,
  decisionRow,
  finalizeReview,
  login,
  openEditor,
  openReviewDetail,
  partDecisionsSaved,
  partLocator,
  submitEditReviewViaApi,
  waitForComparePapers,
  waitForLoaded,
} from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';
const EDIT_MARK = 'restE2E追記';

// 編集画面ヘッダは狭い幅だと保存状態の文言・ボタンが折り返す(`EditorTopBar.vue`)。
// 他の承認系 spec と同じ幅に揃える。
test.use({ viewport: { width: 1440, height: 900 } });

// ── 1. 画面を通した申請と承認(2 つ目は 1 つ目が残した申請を承認する) ──
// 依存を実行順序として明示し、dataRoot はこの describe の中で共有する。ほかのテストより先に
// 宣言する(共有の判定は「直前のテストと同じファイルか」なので、先に別のテストが同じファイルで
// 走ると、その dataRoot を引き継いでしまう)。
test.describe('画面を通した申請と承認', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ keepDataRootAcrossTests: true });

  test('editor がログインして一覧・編集画面を確認し、確定保存を申請する', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, 'editor');
    // セッションはサーバ発行の cookie。実 `POST /api/auth/login` が `Set-Cookie` を
    // 返したことをここで押さえる。
    expect((await page.context().cookies()).map((c) => c.name)).toContain('editor.sid');

    // 一覧は条件を選んで検索するまで出ない。絞り込みは URL クエリと双方向同期する
    // (`useUrlQuerySync.ts`)ので、委託会社(略称)を URL で渡して復元経路から一覧を出す。
    await page.goto('/edit?companyCode=XX01', { waitUntil: 'commit' });
    // ファンド名は Rep1(ファンド一覧)の有無に依存するので、常に描かれるファンドコード・基準日・
    // 版種の 3 列だけで 1 行に絞る。
    const row = page
      .locator('table tr', { hasText: '950037' })
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
    await partLocator(frame)
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
    await expect(
      page.getByRole('status').filter({ hasText: '確定保存を申請しました' }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('approver が承認すると確定ファイルと git コミットへ反映される', async ({ page }) => {
    test.setTimeout(180_000);
    // 申請者(editor)とは別ユーザーで入る。自己承認は職務分掌で拒否される。
    await login(page, 'approver');

    // 承認タブは全申請の一覧から入り、申請行を選んでテンプレートの詳細で精査する。
    await openReviewDetail(page, SEED_ID);

    await expect(chipCount(page, 'pending')).toHaveText('1');
    const item = page.locator('[data-review-item]').first();
    await expect(item).toBeVisible();
    // 地の文への追記がパーツの変更として並ぶ。変更パーツを判定し終えるまで最終確定はできない。
    await expect(item.locator('[data-review-row-no]').first()).toBeVisible({ timeout: 60_000 });
    await expect(item.locator('[data-decision-bar] [data-finalize]')).toBeDisabled();
    await approvePendingParts(page, item);
    await finalizeReview(page, item);

    // 決着すると既定の絞り込み(承認待ち)から外れる。承認済みのチップへ絞って決着の表示を確かめる。
    await expect(chipCount(page, 'pending')).toHaveText('0', { timeout: 30_000 });
    await page.locator('[data-review-chip="approved"]').click();
    const decided = page.locator('[data-review-item]').first();
    await expect(decided).toContainText('承認済み');
    await expect(decided).toContainText('approver');

    // dataRoot の確定ファイルへ反映されたことを実ディスクで確認する。編集タブの承認が書くのは
    // 値入り HTML(`filled/`)で、Jinja スケルトン(`templates/`)は作成タブの承認の担当。
    const html = fs.readFileSync(
      path.join(E2E_REST_DATA_ROOT, 'filled', `${SEED_ID}.html`),
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
});

// ── 2. 申請カードの操作(パーツ 2 つの申請を API で出す) ──
// 最終確定は判定を当てた本文を書く。却下したパーツは申請時点の現行版へ戻り、承認したパーツと
// パーツの外は申請のバイトのまま残る(`shared/src/html/reviewDiff/editReviewedHtml.ts`)。申請の
// 本文を細かく作るため、申請は画面を通さず API で出す(判定と最終確定は画面で行う)。
// 変更は紙面の上から番号が振られる: 1 = 表紙(1 ページ目)、2 = 運用コメント(4 ページ目)。
const PARTIAL_ID = 'XX01_950124_20251020_交付版';
const PARTIAL_CSS = 'XX01_950124_交付版.css';
const APPROVED_MARK = '<p>承認する追記</p>';
const REJECTED_MARK = '<p>却下する追記</p>';
const REJECT_REASON = 'この追記は載せない';

const partialFilledPath = () => path.join(E2E_REST_DATA_ROOT, 'filled', `${PARTIAL_ID}.html`);

function addTo(html: string, cls: string, mark: string): string {
  const open = `<section class="${cls}">`;
  expect(html).toContain(open);
  return html.replace(open, `${open}\n      ${mark}`);
}

/** editor で 2 パーツの申請を出し、approver で申請カードを開いて左右の紙面と 2 行を待つ。 */
async function openPartialReview(page: Page): Promise<Locator> {
  const base = fs.readFileSync(partialFilledPath(), 'utf8');
  const css = fs.readFileSync(path.join(E2E_REST_DATA_ROOT, 'css', PARTIAL_CSS), 'utf8');
  const html = addTo(addTo(base, 'cover_header', APPROVED_MARK), 'report_item_6', REJECTED_MARK);
  await login(page, 'editor');
  await submitEditReviewViaApi(page, { templateId: PARTIAL_ID, html, css });

  await login(page, 'approver');
  await openReviewDetail(page, PARTIAL_ID);
  const item = page.locator('[data-review-item]').first();
  await waitForComparePapers(item);
  await expect(decisionRow(item, 1)).toContainText('承認する追記');
  await expect(decisionRow(item, 2)).toContainText('却下する追記');
  return item;
}

/** 表示中のページに描かれた、ホストの札(page container の直下)。 */
function paperBadge(frame: ReturnType<typeof comparePapers>['after'], kind: string, no?: number) {
  const forNo = no === undefined ? '' : `[data-review-for="${no}"]`;
  return frame.locator(
    `[data-vivliostyle-page-container]:visible > [data-review-badge="${kind}"]${forNo}`,
  );
}

/** 紙面の文書を子へ送った回数(`PreviewPanel.vue` の `data-doc-seq`)。 */
async function docSeq(item: Locator, side: 'before' | 'after'): Promise<number> {
  return Number(await item.locator(`[data-side="${side}"]`).getAttribute('data-doc-seq'));
}

/** 番号 `no` の行の 1 行の却下(理由欄を開き、書いて、保存の応答を待つ)。 */
async function rejectRow(page: Page, item: Locator, no: number, reason: string): Promise<void> {
  const row = decisionRow(item, no);
  await row.getByRole('button', { name: '却下…', exact: true }).click();
  await row.locator('textarea').fill(reason);
  const saved = partDecisionsSaved(page);
  await row.getByRole('button', { name: '却下する', exact: true }).click();
  await saved;
  await expect(row.locator('[data-review-no]')).toHaveAttribute('data-decision', 'rejected');
}

test.describe('申請カードの操作', () => {
  test.describe.configure({ timeout: 180_000 });

  test('紙面のパーツを押すと右欄の行が選ばれ、行を押すと紙面のそのページへ移る', async ({
    page,
  }) => {
    const item = await openPartialReview(page);
    const { before, after } = comparePapers(item);
    const indicator = item.locator('[data-page-indicator]');
    await expect(indicator).toHaveText(/^\s*1 \/ \d+ ページ\s*$/);

    // 紙面(右面)のパーツ 1 を押すと、右欄の行 1 が選ばれる。
    await after
      .locator('[data-vivliostyle-page-container]:visible [data-review-no="1"]')
      .first()
      .click();
    await expect(decisionRow(item, 1)).toHaveAttribute('data-selected', 'true');
    await expect(decisionRow(item, 2)).toHaveAttribute('data-selected', 'false');

    // 右欄の行 2(4 ページ目のパーツ)を押すと、左右の紙面がそのページへ移り、札が見える。
    await decisionRow(item, 2).locator('[data-review-name]').click();
    await expect(decisionRow(item, 2)).toHaveAttribute('data-selected', 'true');
    await expect(indicator).not.toHaveText(/^\s*1 \//, { timeout: 15_000 });
    await expect(paperBadge(after, 'no', 2)).toBeVisible({ timeout: 15_000 });
    await expect(paperBadge(before, 'no', 2)).toBeVisible({ timeout: 15_000 });
  });

  test('承認すると番号が緑になり、右面の data-doc-seq は増えない', async ({ page }) => {
    const item = await openPartialReview(page);
    const { after } = comparePapers(item);
    await expect(paperBadge(after, 'no', 1)).toHaveCSS('background-color', 'rgb(59, 130, 196)');
    const seqBefore = await docSeq(item, 'before');
    const seqAfter = await docSeq(item, 'after');

    const saved = partDecisionsSaved(page);
    await decisionRow(item, 1).getByRole('button', { name: '承認', exact: true }).click();
    await saved;

    const no = decisionRow(item, 1).locator('[data-review-no]');
    await expect(no).toHaveAttribute('data-decision', 'approved');
    await expect(no).toHaveCSS('background-color', 'rgb(47, 138, 95)');
    // 紙面の札も緑になる(目印だけを送り直す)。文書は組み直さない。
    await expect(paperBadge(after, 'no', 1)).toHaveCSS('background-color', 'rgb(47, 138, 95)');
    expect(await docSeq(item, 'after')).toBe(seqAfter);
    expect(await docSeq(item, 'before')).toBe(seqBefore);
  });

  test('却下すると右面だけ組み直し、そのパーツに「却下のため現行版のまま」が出る', async ({
    page,
  }) => {
    const item = await openPartialReview(page);
    const { after } = comparePapers(item);
    const seqBefore = await docSeq(item, 'before');
    const seqAfter = await docSeq(item, 'after');

    await rejectRow(page, item, 2, REJECT_REASON);
    await expect(decisionRow(item, 2)).toContainText(`理由: ${REJECT_REASON}`);
    await expect(decisionRow(item, 2).locator('[data-review-no]')).toHaveCSS(
      'background-color',
      'rgb(192, 57, 43)',
    );

    // 右面だけ文書を送り直す。左面(現行版)は判定に依らない。
    await expect.poll(() => docSeq(item, 'after'), { timeout: 15_000 }).toBe(seqAfter + 1);
    expect(await docSeq(item, 'before')).toBe(seqBefore);
    await waitForComparePapers(item);

    // そのパーツへ移ると、現行版の本文に「却下のため現行版のまま」の札が付き、申請の追記は消える。
    await decisionRow(item, 2).locator('[data-review-name]').click();
    await expect(paperBadge(after, 'keep')).toHaveText('却下のため現行版のまま', {
      timeout: 15_000,
    });
    await expect(after.getByText('却下する追記')).toHaveCount(0);
  });

  test('判定を取り消すと未判定に戻る', async ({ page }) => {
    const item = await openPartialReview(page);
    const row = decisionRow(item, 1);
    let saved = partDecisionsSaved(page);
    await row.getByRole('button', { name: '承認', exact: true }).click();
    await saved;
    await expect(row.locator('[data-review-no]')).toHaveAttribute('data-decision', 'approved');
    await expect(item.locator('[data-decision-progress]')).toContainText('承認 1');

    saved = partDecisionsSaved(page);
    await row.getByRole('button', { name: '判定を取り消す' }).click();
    await saved;
    await expect(row.locator('[data-review-no]')).toHaveAttribute('data-decision', 'pending');
    await expect(row.getByRole('button', { name: '承認', exact: true })).toBeVisible();
    await expect(item.locator('[data-decision-progress]')).toContainText('未判定 2');
  });

  test('まとめて却下は 1 つの理由で選んだパーツを却下する', async ({ page }) => {
    const item = await openPartialReview(page);
    const reqId = await item.getAttribute('data-review-item');
    const band = item.locator('[data-review-band]');
    await item.locator('[data-review-pick-all]').check();
    await expect(band).toContainText('2 件選択中');
    await band.getByRole('button', { name: 'まとめて却下…' }).click();

    // 理由は必須。空のままでは送らない。
    const bulk = item.locator('[data-review-bulk-reject]');
    await bulk.getByRole('button', { name: '2 件を却下する' }).click();
    await expect(bulk).toContainText('理由を入力してください。');

    const reason = 'まとめて却下する理由';
    await bulk.locator('textarea').fill(reason);
    const saved = partDecisionsSaved(page);
    await bulk.getByRole('button', { name: '2 件を却下する' }).click();
    await saved;
    for (const no of [1, 2]) {
      await expect(decisionRow(item, no).locator('[data-review-no]')).toHaveAttribute(
        'data-decision',
        'rejected',
      );
      await expect(decisionRow(item, no)).toContainText(`理由: ${reason}`);
    }

    // サーバにも、選んだパーツそれぞれへ同じ理由で保存されている。
    const res = await page.request.get(`/api/review-requests/${encodeURIComponent(reqId ?? '')}`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      partDecisions?: { status: string; comment?: string | null }[];
    };
    // 判定の並びは保存の順に依るので、件数と中身だけを見る。
    const stored = body.partDecisions ?? [];
    expect(stored).toHaveLength(2);
    for (const d of stored) expect([d.status, d.comment]).toEqual(['rejected', reason]);
  });

  test('すべて判定すると最終確定でき、却下したパーツは現行版のまま確定される', async ({ page }) => {
    const base = fs.readFileSync(partialFilledPath(), 'utf8');
    const item = await openPartialReview(page);
    const finalize = item.locator('[data-decision-bar] [data-finalize]');

    // 1 つ却下しただけでは未判定が残り、最終確定は押せない。
    await rejectRow(page, item, 2, REJECT_REASON);
    await expect(finalize).toBeDisabled();

    // 残り(表紙の追記)を承認すると押せるようになる。
    await approvePendingParts(page, item);
    await finalizeReview(page, item);
    await expect(chipCount(page, 'pending')).toHaveText('0', { timeout: 30_000 });

    // 却下したパーツは現行版、承認したパーツとパーツの外は申請のバイトのまま。
    expect(fs.readFileSync(partialFilledPath(), 'utf8')).toBe(
      addTo(base, 'cover_header', APPROVED_MARK),
    );

    // 申請者が編集画面を開くと、却下したパーツの理由が右ペインに出る(`useRejectedReasons.ts`)。
    await login(page, 'editor');
    await openEditor(page, PARTIAL_ID);
    await expect(page.locator('[data-rejected-reason]').first()).toContainText(REJECT_REASON, {
      timeout: 30_000,
    });
  });
});

// ── 3. 画面の幅 ──
// 承認タブの作業域は左右の紙面と 420px の右欄(モックの値)。本文の最大幅を 1400px 未満へ
// 狭めない(却下済み設計 41)ので、1400px で紙面が読める倍率に収まることを確かめる。倍率は
// 子(隔離 iframe のホスト)がフィットで決め、状態通知で親へ返す(`previewHost.ts` の
// `ZOOM_MIN` = 0.4 が下限)。親の画面は倍率を DOM に出さないので、通知を横から読む。
const ZOOM_MIN = 0.4;

test.describe('1400px の画面', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('1400px の画面でも左右の紙面のフィット倍率が下限に張り付かない', async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      if (window.top !== window) return;
      const w = window as unknown as { __e2eZoom: Record<string, number> };
      w.__e2eZoom = {};
      window.addEventListener('message', (e) => {
        const d = e.data as { type?: string; state?: { ready?: boolean; zoom?: number } } | null;
        if (d?.type !== 'editor:preview-state' || d.state?.ready !== true) return;
        for (const f of document.querySelectorAll('iframe')) {
          if (f.contentWindow !== e.source) continue;
          const side = f.closest('[data-side]')?.getAttribute('data-side');
          if (side) w.__e2eZoom[side] = Number(d.state.zoom);
        }
      });
    });
    const item = await openPartialReview(page);
    const zoomOf = () =>
      page.evaluate(() => (window as unknown as { __e2eZoom: Record<string, number> }).__e2eZoom);
    await expect
      .poll(async () => Object.keys(await zoomOf()).sort(), { timeout: 30_000 })
      .toEqual(['after', 'before']);
    const zoom = await zoomOf();
    const box = await item.locator('[data-review-work]').boundingBox();
    test.info().annotations.push({
      type: 'zoom',
      description: `before=${zoom.before} after=${zoom.after} work=${box?.width}x${box?.height}`,
    });
    console.log(
      `[zoom@1400] before=${zoom.before} after=${zoom.after} work=${box?.width}x${box?.height}`,
    );
    expect(zoom.before).toBeGreaterThan(ZOOM_MIN);
    expect(zoom.after).toBeGreaterThan(ZOOM_MIN);
  });
});
