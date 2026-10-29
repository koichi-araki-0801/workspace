// =============================================================================
// review_tab.spec.ts — 承認タブが対象テンプレートの申請を並べ、1 件ずつ決着できることの回帰網
// =============================================================================
// 全申請一覧(申請が無ければ編集タブへの誘導)から行を選んでテンプレート詳細(?template=)へ
// 進む経路、見出しの行(パンくず・状態の絞り込みチップ)の件数、同時展開の上限、申請ごとの却下の
// あとも同じ画面へ留まること、右欄の表示窓が見えている行を動かさないことを実機で固定する。
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import {
  chipCount,
  commentInput,
  login,
  openEditor,
  openReviewDetail,
  pagePartLocator,
  reportMeasure,
  selectPart,
  submitEditReviewViaApi,
  submitOnce,
  waitForComparePapers,
} from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * 申請カード `item` の見出しの「申請ごと却下する…」から理由を書いて申請を却下する。
 * 却下の完了はトースト「却下しました」で知る。
 */
async function rejectRequest(page: Page, item: Locator, reason: string): Promise<void> {
  await item.locator('[data-review-reject-link]').click();
  const box = item.locator('[data-request-reject]');
  await expect(box.locator('textarea')).toBeFocused();
  await box.locator('textarea').fill(reason);
  await box.getByRole('button', { name: '申請を却下する' }).click();
  await expect(page.getByRole('status').filter({ hasText: '却下しました' })).toBeVisible({
    timeout: 30_000,
  });
}

test('申請が無ければ全申請一覧で誘導し、全申請一覧の行から対象テンプレートの詳細を開く', async ({
  page,
}) => {
  // 組版を 2 面走らせる重いテストで、並列負荷下では既定 30s を超えるため他の重い spec と同じ 120s にする。
  test.setTimeout(120_000);
  // 申請が 1 件も無い全申請一覧は、申請の出し方を案内して編集タブへ誘導する。
  await login(page, 'approver');
  await page.goto('/reviews');
  await expect(page.getByText('編集タブでテンプレートを開いてから')).toBeVisible();
  await page.getByRole('button', { name: '編集タブへ' }).click();
  await expect(page).toHaveURL(/\/edit/);

  // 同じ人が同じ本文を 2 回申請すると、2 回目は重複(409 `REVIEW_DUPLICATE`)として断られる。
  // 承認待ちを 2 件作るために申請者を分ける — 重複の判定は申請者ごとなので、本文は同じでよい。
  await login(page, 'admin');
  await submitOnce(page, SEED_ID);
  await login(page, 'editor');
  await submitOnce(page, SEED_ID);

  // 全申請一覧はチップつきで申請を並べるが、区画は開かない(詳細へ進む行として並ぶ)。
  await login(page, 'approver');
  await openEditor(page, SEED_ID);
  await page.getByRole('link', { name: '承認' }).click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(page.getByText('編集タブでテンプレートを開いてから')).toHaveCount(0);
  await expect(page.locator('[data-review-crumb]')).toHaveText('すべての申請');
  await expect(chipCount(page, 'pending')).toHaveText('2');
  await expect(page.locator('[data-review-item]')).toHaveCount(2);
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(0);

  // 行を選ぶとそのテンプレートの詳細へ進み、パンくずにテンプレート ID が出て、同じテンプレートの
  // 申請 2 件が並ぶ。
  await page.locator('[data-review-item] [data-review-toggle]').first().click();
  await expect(page).toHaveURL(new RegExp(`[?&]template=${encodeURIComponent(SEED_ID)}`));
  await expect(page.locator('[data-review-crumb-id]')).toHaveText(SEED_ID);
  await expect(chipCount(page, 'pending')).toHaveText('2');
  await expect(page.locator('[data-review-item]')).toHaveCount(2);
  // 先頭だけ展開されている(左右の紙面の 2 面)
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(2);

  // 2 件目も開くと合計 4 面。上限 2 件なので 3 件目は無いが、両方開いた状態を確認する
  await page.locator('[data-review-toggle]').nth(1).click();
  await expect(page.locator('[data-review-item] iframe[title="プレビュー"]')).toHaveCount(4);

  // 先頭を申請ごと却下すると同じ画面に留まり、承認待ちが 1 件に減る
  await rejectRequest(page, page.locator('[data-review-item]').first(), '数値を確認してください');
  await expect(page).toHaveURL(/\/reviews/);
  await expect(chipCount(page, 'pending')).toHaveText('1');
  await expect(chipCount(page, 'rejected')).toHaveText('1');
  await expect(page.locator('[data-review-item]')).toHaveCount(1);

  // チップをもう一度押すと絞り込みを外し、却下済みも並ぶ。
  await page.locator('[data-review-chip="pending"]').click();
  await expect(page.locator('[data-review-chip="pending"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.locator('[data-review-item]')).toHaveCount(2);

  // パンくずの「すべての申請」で全申請の一覧へ戻る。
  await page.locator('[data-review-crumb]').getByRole('button', { name: 'すべての申請' }).click();
  await expect(page).toHaveURL(/\/reviews$/);
});

test('申請ごと却下は見出しのリンクから理由を書いて申請を却下する', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, 'admin');
  await submitOnce(page, SEED_ID);

  await login(page, 'approver');
  await openReviewDetail(page, SEED_ID);
  const item = page.locator('[data-review-item]').first();
  const link = item.locator('[data-review-reject-link]');
  await expect(link).toHaveText('申請ごと却下する…');

  // リンクを押すとカードの先頭に理由欄が開く。理由は必須で、空のままでは却下しない。
  await link.click();
  const box = item.locator('[data-request-reject]');
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: '申請を却下する' }).click();
  await expect(box.getByRole('alert')).toHaveText('理由を入力してください。');
  await expect(chipCount(page, 'pending')).toHaveText('1');

  // 取消で閉じ、もう一度開いて理由を書いて却下する。
  await box.getByRole('button', { name: '取消' }).click();
  await expect(box).toHaveCount(0);
  await rejectRequest(page, item, '表紙の日付を直してください');

  await expect(chipCount(page, 'pending')).toHaveText('0');
  await expect(chipCount(page, 'rejected')).toHaveText('1');
  // 却下済みへ絞ると、見出しに処理者と理由が出て、却下のリンクは出ない。
  await page.locator('[data-review-chip="rejected"]').click();
  const decided = page.locator('[data-review-item]').first();
  await expect(decided).toContainText('却下済み');
  await expect(decided).toContainText('却下: approver');
  await expect(decided).toContainText('理由: 表紙の日付を直してください');
  await expect(decided.locator('[data-review-reject-link]')).toHaveCount(0);
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
  await selectPart(page.frameLocator('iframe.gjs-frame'), part);
  const input = commentInput(page);
  await expect(input).toBeEnabled();
  await input.fill(content);
  await page.locator('button[data-add-submit]').click();
  await expect(page.locator('[data-comment-row]', { hasText: content })).toBeVisible();
}

test('承認タブのコメントの行クリックで左右の紙面が該当ページ(2 ページ目)へ移動する', async ({
  page,
}) => {
  // 組版を 2 面走らせる重いテストで、並列負荷下では既定 30s を超えるため他の重い spec と同じ 120s にする。
  test.setTimeout(120_000);
  // 2 ページ目先頭パーツ宛にコメントを 1 件用意して申請する(区画の内容自体は未編集でよい)。
  const COMMENT_TEXT = '2ページ目パーツへの確認コメント';
  await login(page, 'admin');
  await openEditor(page, SEED_ID);
  // 既定の 1 ページ表示では 2 ページ目が canvas 上で非表示(display:none)のまま。全ページ
  // 連続表示へ切り替えてから対象パーツを選ぶ。
  await page.getByRole('button', { name: '全ページを連続表示' }).click();
  await page.locator('[data-pane-tab="comments"]').click();
  const secondPagePart = pagePartLocator(page.frameLocator('iframe.gjs-frame'), 1).first();
  await addCanvasComment(page, secondPagePart, COMMENT_TEXT);
  await submitOnce(page, SEED_ID);

  // 紙面のホストページの応答を止めておき、紙面がまだ組まれていない間に行を押す(組版を待ってから送る
  // 経路を必ず通す。止めないと、組版の速さ次第で「すぐ送る」経路に入れ替わる)。
  let releaseHost: () => void = () => {};
  const hostHeld = new Promise<void>((resolve) => {
    releaseHost = resolve;
  });
  await page.route(
    (url) => url.pathname.endsWith('/preview-host/index.html'),
    async (route) => {
      await hostHeld;
      await route.continue();
    },
  );

  await login(page, 'approver');
  await openReviewDetail(page, SEED_ID);

  const item = page.locator('[data-review-item]').first();
  // コメントは右欄の「コメント」タブにある。
  await item.locator('[data-side-tab="comments"]').click();
  const row = item.locator('[data-comment-row]', { hasText: COMMENT_TEXT });
  await expect(row).toBeVisible();
  // 到達可能なコメントであることの前提確認(削除済みパーツ扱いなら行クリックは no-op)。
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  const pageIndicator = item.locator('[data-page-indicator]');
  const onSecondPage = /^\s*2 \/ \d+ ページ\s*$/;

  // 紙面はまだ組まれていない(ホストページを止めている)。この間に押すと、`ReviewDetail.pendingIndex`
  // → `ReviewVisualCompare.pendingPageIndex` に送り先を預け、組版が終わってから 2 ページ目へ送る。
  // 子の文書はまだ読み込まれていないので、子の中を見ずに親の「生成中」の表示で確かめる(子の中を
  // locator で見ると、読み込みを待ち続けて進まない)。
  await expect(item.getByText('プレビューを生成中…', { exact: true })).toHaveCount(2);
  await row.click();
  await expect(pageIndicator).not.toHaveText(onSecondPage);
  releaseHost();
  await waitForComparePapers(item);
  await expect(pageIndicator).toHaveText(onSecondPage, { timeout: 15_000 });

  // 前のページへ戻してから押し直すと、組版の済んだ紙面へ即座に送る経路で 2 ページ目へ移る。
  await item.locator('[data-page-prev]').click();
  await expect(pageIndicator).toHaveText(/^\s*1 \/ \d+ ページ\s*$/);
  await row.click();
  await expect(pageIndicator).toHaveText(onSecondPage, { timeout: 15_000 });
});

// ── 右欄の表示窓 ──
// 右欄「変更と判定」は `[start, end)` の窓だけを描き(上限 150 行、50 行ずつ足す)、上下は見込み高の
// 余白で埋める(`reviewDecisionList.ts`)。窓の上端で行を足す・外すときは `scrollTop` を補い、見えて
// いる行を動かさない。量は単体テストで見ているので、ここは実ブラウザで位置が動かないことを測る。

/** 長い段落の文(右欄の行で数行に折り返し、行の高さを不揃いにする)。 */
const LONG_TEXT = '追加した長い段落です。右欄の行で何行にも折り返すように同じ文を続けます。'.repeat(
  4,
);

/**
 * 追加のパーツが `count` 個ある申請の本文(確定版の末尾にパーツを足す)。`uneven` なら 3 つに 1 つを
 * 長い段落にして、右欄の行の高さを揃えない(見込み高と実高の差が窓の補正に効く形)。
 */
function withAddedParts(base: string, count: number, uneven = false): string {
  const added = Array.from({ length: count }, (_, i) => {
    const text = uneven && i % 3 === 1 ? `${LONG_TEXT}(${i + 1})` : `追加した段落 ${i + 1}`;
    return `<section class="e2e_added_${i}"><p>${text}</p></section>`;
  }).join('\n');
  expect(base).toContain('</body>');
  return base.replace('</body>', `${added}\n</body>`);
}

interface WindowProbe {
  /** 描いている先頭・末尾の行の番号。 */
  first: number;
  last: number;
  /** 表示窓の中ほどに見えている行の番号と、その上端の y(px)。 */
  anchorNo: number;
  anchorTop: number;
}

/**
 * 描いている行の端を表示窓の端へ合わせる(`bottom`: 末尾の行の下端を下端へ、`top`: 先頭の行の
 * 上端を上端へ)。番兵(余白)が IntersectionObserver の `rootMargin`(200px)の中に入るので、
 * 窓が動く。合わせた直後に、中ほどに見えている行を目印として測って返す(窓が動く前の位置)。
 */
async function alignWindowEdge(scroller: Locator, edge: 'bottom' | 'top'): Promise<WindowProbe> {
  return scroller.evaluate((el, which) => {
    const rows = [...el.querySelectorAll<HTMLElement>('[data-review-row-no]')];
    const view = el.getBoundingClientRect();
    const target = which === 'bottom' ? rows[rows.length - 1] : rows[0];
    const t = target.getBoundingClientRect();
    el.scrollTop += which === 'bottom' ? t.bottom - view.bottom : t.top - view.top;
    const mid = view.top + view.height / 2;
    const anchor =
      rows.find((r) => {
        const b = r.getBoundingClientRect();
        return b.top <= mid && b.bottom >= mid;
      }) ?? target;
    return {
      first: Number(rows[0].dataset.reviewRowNo),
      last: Number(rows[rows.length - 1].dataset.reviewRowNo),
      anchorNo: Number(anchor.dataset.reviewRowNo),
      anchorTop: anchor.getBoundingClientRect().top,
    };
  }, edge);
}

/** 描いている先頭・末尾の行の番号。 */
async function renderedRange(scroller: Locator): Promise<[number, number]> {
  return scroller.evaluate((el) => {
    const rows = el.querySelectorAll<HTMLElement>('[data-review-row-no]');
    return [
      Number(rows[0]?.dataset.reviewRowNo),
      Number(rows[rows.length - 1]?.dataset.reviewRowNo),
    ];
  });
}

/** 窓が動いて補正を終えたあと(2 フレーム待つ)の、番号 `no` の行の上端の y(px)。 */
async function rowTopAfterFrames(scroller: Locator, no: number): Promise<number> {
  return scroller.evaluate(async (el, n) => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const row = el.querySelector<HTMLElement>(`[data-review-row-no="${n}"]`);
    return row ? row.getBoundingClientRect().top : Number.NaN;
  }, no);
}

/** 窓の端を合わせて窓が動くのを待ち、目印の行の位置のずれ(px)と動いたあとの範囲を返す。 */
async function moveWindow(
  scroller: Locator,
  edge: 'bottom' | 'top',
): Promise<{ probe: WindowProbe; range: [number, number]; drift: number }> {
  const probe = await alignWindowEdge(scroller, edge);
  await expect
    .poll(() => renderedRange(scroller), { timeout: 10_000 })
    .not.toEqual([probe.first, probe.last]);
  const top = await rowTopAfterFrames(scroller, probe.anchorNo);
  return { probe, range: await renderedRange(scroller), drift: top - probe.anchorTop };
}

const ADDED_PARTS = 210;
const DRIFT_PX = 2;

/** 描いている行の高さ(px、小数 1 桁)の種類の数。不揃いの申請で本当に揃っていないことを確かめる。 */
async function rowHeightKinds(scroller: Locator): Promise<number> {
  return scroller.evaluate((el) => {
    const rows = [...el.querySelectorAll<HTMLElement>('[data-review-row-no]')];
    return new Set(rows.map((r) => r.getBoundingClientRect().height.toFixed(1))).size;
  });
}

for (const shape of [
  { name: '行の高さが揃っている', uneven: false },
  { name: '行の高さが不揃い', uneven: true },
] as const) {
  test(`右欄の表示窓を動かしても見えている行が ±2px で動かない(上から外す・上へ戻す・${shape.name})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const base = fs.readFileSync(
      path.join(E2E_REST_DATA_ROOT, 'filled', `${SEED_ID}.html`),
      'utf8',
    );
    const css = fs.readFileSync(
      path.join(E2E_REST_DATA_ROOT, 'css', 'XX01_950037_交付版.css'),
      'utf8',
    );
    await login(page, 'editor');
    await submitEditReviewViaApi(page, {
      templateId: SEED_ID,
      html: withAddedParts(base, ADDED_PARTS, shape.uneven),
      css,
    });

    await login(page, 'approver');
    await openReviewDetail(page, SEED_ID);
    const item = page.locator('[data-review-item]').first();
    const scroller = item.locator('[data-review-scroller]');
    await expect(item.locator('[data-review-row-no]').first()).toBeVisible({ timeout: 60_000 });
    // 初めは先頭から 50 行だけを描く。
    await expect.poll(() => renderedRange(scroller)).toEqual([1, 50]);
    // 不揃いの申請では行の高さが揃っていない(長い段落の行が数行に折り返す)。
    if (shape.uneven) expect(await rowHeightKinds(scroller)).toBeGreaterThan(1);

    // 下へ進める。150 行を超えると上から外す(先頭の番号が進む)。どの一歩でも目印の行は動かない。
    const drifts: string[] = [];
    let dropped = false;
    for (let step = 0; step < 6 && !dropped; step++) {
      const { probe, range, drift } = await moveWindow(scroller, 'bottom');
      drifts.push(
        `down ${probe.first}-${probe.last}→${range[0]}-${range[1]} drift=${drift.toFixed(2)}`,
      );
      expect(Math.abs(drift), drifts.join(' / ')).toBeLessThanOrEqual(DRIFT_PX);
      dropped = range[0] > probe.first;
    }
    expect(dropped, drifts.join(' / ')).toBe(true);

    // 上へ戻す。窓の先頭より上の行を描き足し、目印の行は動かない。
    const { probe, range, drift } = await moveWindow(scroller, 'top');
    drifts.push(
      `up ${probe.first}-${probe.last}→${range[0]}-${range[1]} drift=${drift.toFixed(2)}`,
    );
    reportMeasure(`review-window ${shape.name}`, drifts.join(' / '));
    expect(range[0], drifts.join(' / ')).toBeLessThan(probe.first);
    expect(Math.abs(drift), drifts.join(' / ')).toBeLessThanOrEqual(DRIFT_PX);
  });
}
