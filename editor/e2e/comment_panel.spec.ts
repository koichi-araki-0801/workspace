// =============================================================================
// comment_panel.spec.ts — 右ペインのコメント一覧が検索・絞り込み・パーツ移動を実際に行うことの回帰網
// =============================================================================
// 一覧は右ペイン(overlay 層の外)にあるので pointer-events の罠は無いが、行クリックが
// GrapesJS の選択と 1 ページ表示のページ送りまで届くかは実機でしか分からない。ここで押さえる。
// 一覧はパーツの見出しごとに束ね、投稿欄の上には宛先のパーツを枠で出す(`CommentPanel.vue`)。
// 承認タブでは宛先を紙面で選んでから書く(選ぶまでは入力欄を畳んで案内を出す)。
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_REST_DATA_ROOT } from '../server/scripts/e2e-rest-paths';
import { expect, test } from './fixtures';
import {
  commentInput,
  comparePapers,
  login,
  openEditor,
  openReviewDetail,
  partLocator,
  selectPart,
  submitEditReviewViaApi,
  waitForComparePapers,
} from './helpers';

const SEED_ID = 'XX01_950037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function addComment(page: Page, partIndex: number, text: string): Promise<void> {
  const frame = page.frameLocator('iframe.gjs-frame');
  const part = partLocator(frame).nth(partIndex);
  await part.waitFor({ state: 'visible', timeout: 30_000 });
  await selectPart(frame, part);
  // 選択が右ペインへ反映されると、宛先の枠が出て入力欄が有効になる(未選択時は disabled)。
  await expect(page.locator('[data-comment-target]')).toHaveClass(/target-box/);
  await expect(commentInput(page)).toBeEnabled();
  await commentInput(page).fill(text);
  await page.locator('button[data-add-submit]').click();
  await expect(page.locator('[data-comment-row]', { hasText: text })).toBeVisible();
}

test('コメント一覧は検索・状態で絞り込め、行クリックでパーツを選択する', async ({ page }) => {
  await login(page);
  await openEditor(page, SEED_ID);
  await page.locator('[data-pane-tab="comments"]').click();
  // 宛先を選ぶ前は、未選択であることを点線の枠で示し、入力欄は押せない。
  await expect(page.locator('[data-comment-target-none]')).toBeVisible();
  await expect(commentInput(page)).toBeDisabled();

  // 吹き出しはページへ常に重ねて出る仕様(表計算ソフトのセルコメントと同じ)なので、直前に
  // 開いた吹き出しがすぐ下のパーツを覆い、そこへのクリックを吸収してしまう。2 件目は
  // 1 件目より前方(canvas 上で上側)の index を選び、吹き出しの被覆を避ける。
  await addComment(page, 1, '表紙の日付');
  await addComment(page, 0, '要約の数値');

  const rows = page.locator('[data-comment-row]');
  await expect(rows).toHaveCount(2);
  // 一覧はパーツの見出しごとに束ねる。2 件は別のパーツなので見出しが 2 つ。
  const groups = page.locator('[data-comment-group]');
  await expect(groups).toHaveCount(2);
  const groupOf = (text: string) => groups.filter({ has: rows.filter({ hasText: text }) });
  await expect(groupOf('表紙の日付')).toHaveCount(1);
  await expect(groupOf('表紙の日付').locator('[data-comment-row]')).toHaveCount(1);
  await expect(groupOf('要約の数値').locator('[data-comment-row]')).toHaveCount(1);

  // 並びは既定で更新順(最新のスレッドを持つ見出しが先頭)。パーツ順ではパーツの並びに従う。
  await expect(groups.first()).toContainText('要約の数値');
  await rows.filter({ hasText: '表紙の日付' }).locator('[data-expand]').click();
  await page.locator('[data-reply-content]').fill('日付を確認します');
  await page.locator('[data-reply-submit]').click();
  await expect(groups.first()).toContainText('表紙の日付');
  await page.locator('[data-filter-sort]').selectOption('part');
  await expect(groups.first()).toContainText('要約の数値');
  await page.locator('[data-filter-sort]').selectOption('updated');

  await page.getByLabel('コメントを検索').fill('数値');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('要約の数値');
  await page.getByLabel('コメントを検索').fill('');

  // 1 件目を解決すると既定(未対応)の一覧から消え、「すべて」で戻る(返信の入力で開いたまま)。
  await page.locator('[data-resolve]').click();
  await expect(rows).toHaveCount(1);
  await page.locator('[data-filter-status]').selectOption('all');
  await expect(rows).toHaveCount(2);

  // 展開中の行は本文欄が `@click.stop` を持つ(返信・解決ボタンの誤発火防止)ため、行クリックの
  // 判定領域は畳んでからでないと押せる範囲がヘッダだけに狭まる。ここで畳んでおく。
  await rows.filter({ hasText: '表紙の日付' }).locator('[data-expand]').click();
  await expect(rows.filter({ hasText: '表紙の日付' }).locator('[data-expand]')).toHaveAttribute(
    'aria-label',
    '開く',
  );

  // 行クリックで別パーツが選択され、吹き出しがそのパーツのスレッドを出す。
  await rows.filter({ hasText: '表紙の日付' }).click();
  await expect(page.locator('.note-bubble')).toContainText('表紙の日付');
  await expect(page.locator('.note-bubble')).not.toContainText('要約の数値');
  // 見出しを押しても、そのパーツが宛先になる。
  await groupOf('要約の数値').locator('[data-comment-group-head]').click();
  await expect(page.locator('.note-bubble')).toContainText('要約の数値');
});

test('承認タブのコメントは紙面でパーツを選んで書き、そのパーツの見出しの下に並ぶ', async ({
  page,
}) => {
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
  await waitForComparePapers(item);
  await item.locator('[data-side-tab="comments"]').click();

  // 宛先を選ぶまでは入力欄を畳み、紙面で選ぶよう案内する。
  await expect(item.locator('[data-add-collapsed]')).toBeVisible();
  await expect(item.locator('textarea[data-add-content]')).toHaveCount(0);

  // 紙面のパーツ 1 を押すと、宛先に番号と名前が出て書けるようになる。
  await comparePapers(item)
    .after.locator('[data-vivliostyle-page-container]:visible [data-review-no="1"]')
    .first()
    .click();
  const target = item.locator('[data-comment-target]');
  await expect(target.locator('[data-part-no]')).toHaveText('1');
  const input = item.locator('textarea[data-add-content]');
  await expect(input).toBeEnabled();
  await input.fill('承認者からの確認');
  await item.locator('button[data-add-submit]').click();

  // 投稿はそのパーツの見出し(同じ番号)の下に並ぶ。
  const group = item
    .locator('[data-comment-group]')
    .filter({ has: page.locator('[data-comment-row]', { hasText: '承認者からの確認' }) });
  await expect(group).toHaveCount(1);
  await expect(group.locator('[data-comment-group-head] [data-part-no]')).toHaveText('1');

  // 同じパーツをもう一度押すと選択が外れ、宛先も外れて入力欄を畳む。
  await comparePapers(item)
    .after.locator('[data-vivliostyle-page-container]:visible [data-review-no="1"]')
    .first()
    .click();
  await expect(item.locator('[data-add-collapsed]')).toBeVisible();
});
