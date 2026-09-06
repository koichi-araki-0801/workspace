// =============================================================================
// header_layout.spec.ts — 編集画面ヘッダが 1 行に収まること
// =============================================================================
// ヘッダは `flex-wrap` で、狭幅では塊ごと次行へ折り返す(`EditorTopBar.vue` のズーム崩れ
// 回避)。ただし通常の画面幅でまで折り返すと、最重要アクションの「プレビュー」だけが
// 2 行目の左端へ孤立する。折り返しの余裕はファンド名の長さと保存状態の文言で簡単に
// 食い潰されるので、その両方が最長の状態で 1 行に収まることを 2 つの幅で固定する。
import { expect, type Page, test } from '@playwright/test';
import { login, openEditor } from './helpers';

// 長いファンド名(SMT JPX日経中小型株インデックス・オープン)を持つ seed。ファンド名は
// ヘッダ左ゾーンの幅を決めるので、短い名前の seed では余裕の不足を検出できない。
const LONG_NAME_ID = 'AM01_510124_20251020_交付版';

// 通常系で最も長い保存状態の文言(`EditorView.vue` の `statusText`)。実際にこれを出すには
// 本文を編集して自動保存を待つ必要があり、GrapesJS の RTE 操作を挟むと測定が不安定に
// なるので、文言だけを差し込んで幅を測る。書式を変えたらここも合わせること。異常系の
// 「保存に失敗しました」は再試行ボタンも増えるため、折り返してでも全部出すのが正しく、
// ここでは測らない。
const LONGEST_STATUS = '00:00 に自動保存';

/**
 * 編集画面の上部バー(`EditorTopBar.vue`)。アプリヘッダ(`MainLayout.vue`)も `header` 要素
 * なので、素の `header` では先頭のアプリヘッダを掴んで別要素を測ってしまう。上部バーだけが
 * 持つ「一覧へ戻る」で選ぶ。
 */
const TOP_BAR = 'header:has([aria-label="一覧へ戻る"])';

/**
 * `selector` が指す要素の子要素が何行に分かれているか。判定に上端でなく**中心の y**を
 * 使うのは、右ゾーンを押しやるスペーサー(`<span class="flex-1" />`)が高さゼロで、上端だと
 * 同じ行にいても他の要素と 20px 以上ずれるため。
 */
async function headerRows(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const header = document.querySelector(sel);
    if (!header) return -1;
    const centers = Array.from(header.children).map((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const base = Math.min(...centers);
    return new Set(centers.map((y) => Math.round((y - base) / 20))).size;
  }, selector);
}

async function openLongNameEditor(page: Page) {
  await login(page);
  await openEditor(page, LONG_NAME_ID);
}

test('1440px: 長いファンド名でもヘッダが 1 行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLongNameEditor(page);
  // この幅では保存状態の文言は出ない(アイコンのみ)。出すと必ず溢れる。
  await expect(page.locator(`${TOP_BAR} [role="status"] span`).last()).toBeHidden();
  expect(await headerRows(page, TOP_BAR)).toBe(1);
});

test('1600px: 保存状態の文言が出る幅でもヘッダが 1 行に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openLongNameEditor(page);
  await expect(page.locator(`${TOP_BAR} [role="status"] span`).last()).toBeVisible();
  await page.evaluate(
    ([sel, status]) => {
      const label = document.querySelector(`${sel} [role="status"] span:last-child`);
      if (label) label.textContent = status;
    },
    [TOP_BAR, LONGEST_STATUS] as const,
  );
  await expect(page.locator(`${TOP_BAR} [role="status"]`)).toContainText(LONGEST_STATUS);
  expect(await headerRows(page, TOP_BAR)).toBe(1);
});

/**
 * アプリヘッダ(`MainLayout.vue`)の 1 行。ロゴ・タブ群・右端(管理者/テーマ/ユーザー)は
 * 同じ行の直接の子なので、その親の行を測る。
 */
const APP_HEADER_ROW = 'header:has(nav) > div';

/** 要素の縦中心 y。ロゴとタブが同じ行にあるかの判定に使う。 */
async function centerY(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return r ? r.top + r.height / 2 : -1;
  }, selector);
}

for (const width of [1440, 1600, 1920]) {
  test(`${width}px: アプリヘッダ(ロゴ + タブ + 右端)が 1 行に収まり、横に溢れない`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openLongNameEditor(page);
    // ロゴは副文言まで出す(落として幅を稼がない)
    await expect(page.getByText('Report Edit Tool')).toBeVisible();
    await expect(page.getByRole('link', { name: '履歴' })).toBeVisible();
    // ロゴとタブが同じ行にある(2 段ヘッダなら約 50px ずれる)
    const logoY = await centerY(page, 'header:has(nav) span.tracking-\\[0\\.1em\\]');
    const tabY = await centerY(page, 'header nav a[aria-current="page"]');
    expect(Math.abs(logoY - tabY)).toBeLessThanOrEqual(2);
    expect(await headerRows(page, APP_HEADER_ROW)).toBe(1);
    const overflow = await page.evaluate((sel) => {
      const row = document.querySelector(sel);
      return row ? row.scrollWidth - row.clientWidth : -1;
    }, APP_HEADER_ROW);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('1920px: 本文の最大幅は 1760px(編集 3 ペインの固定幅 584px + ページ 794px の要件)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openLongNameEditor(page);
  const widths = await page.evaluate((sel) => {
    const bar = document.querySelector(sel);
    const main = document.querySelector('main');
    return {
      bar: bar?.getBoundingClientRect().width ?? -1,
      main: main?.getBoundingClientRect().width ?? -2,
    };
  }, TOP_BAR);
  expect(Math.round(widths.main)).toBe(1760);
  // 上部バーは main の全幅を使う(flush で左右の余白が無い)
  expect(Math.abs(widths.bar - widths.main)).toBeLessThanOrEqual(1);
  expect(await headerRows(page, TOP_BAR)).toBe(1);
});
