// =============================================================================
// capture_docs.spec.ts — 操作手順書(docs/editor)向けスクリーンショット取得
// =============================================================================
// 実行は editor 配下で(`docs` project だけが本 spec を担当し、`chromium` は ignore する):
//   pnpm exec playwright test --project docs
// `playwright.config.ts` の webServer が sproc フェイクのサーバ(:24680)と Vite(:24681)を
// 起動する。ログインはサーバ発行の cookie で、編集/プレビューは seed テンプレ
// (XX01_950037_20240710_交付版)へ直接遷移して撮る。承認系(reviews-list/review-diff/
// review-decide)は editor が 3 パーツを直した申請を API で出し → approver で承認タブを開いて判定し
// (`login()` が cookie を捨てて切り替える)、最終確定のあとに editor で編集画面を開いて
// 変更の目印と前回の却下の理由(editor-marks)を撮る。
// 撮影は `animations: 'disabled'` で行う。スピナーの回転角やタブ切替のトランジション途中が
// 写ると、内容が同じでもバイト列が run ごとに変わり、pre-push の再撮影が毎回作業ツリーを汚す。

import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FrameLocator, Locator, Page } from '@playwright/test';
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
  partDecisionsSaved,
  partLocator,
  submitEditReviewViaApi,
  waitForComparePapers,
  waitForLoaded,
  waitForStableBox,
} from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = (name: string) => resolve(here, '../../docs/editor/images', name);
const SEED_ID = 'XX01_950037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * プレビューの組版完了を待つ。ページ要素は隔離 iframe(`sandbox="allow-scripts"`・
 * same-origin なし)の中に出るため、トップ文書の locator では永久に 0 件になる。
 * Playwright は sandbox 付きフレームの中も frameLocator で辿れる。
 *
 * `:visible` で絞るのは、見開き表示で vivliostyle が左右 1 対のページ容器を作り、
 * **本文が入らない側(`data-vivliostyle-page-side="right"` の空きスロット)が hidden のまま
 * DOM 先頭に来る**ため。素の `.first()` はそれを掴んで可視化を待ち続け timeout する。
 */
async function waitForPreviewPage(page: Page) {
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
}

/**
 * 走っている CSS トランジションが終わるまで待つ。`animations: 'disabled'` は撮影の瞬間に
 * 有限アニメーションを終端へ進めて見た目を揃えるが、進行中の要素は合成レイヤへ昇格したままで、
 * 丸い縁の反エイリアスが数階調ずれる(タブ切替直後の `history-tab.png` で実測。見た目は同じでも
 * PNG のバイト列が変わり、作業ツリーが汚れる)。無限アニメーション(スピナー等)は撮影時に
 * 停止されるので待たない — 待つと永久に終わらない。
 *
 * 撮影の直前に一律で呼ぶ。必要なのはタブ遷移を挟む数枚だけだが、どの画面がアニメーションを
 * 持つかは実装の変更で動くため、「必要な画面を選ぶ」形にすると選び漏れが撮影のばらつきとして
 * 出る。進行中のアニメーションが無ければ即座に解決するので、一律で呼ぶ費用はほぼ無い。
 */
async function waitForTransitionsSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getAnimations().every((a) => {
        const timing = a.effect?.getComputedTiming();
        if (timing?.iterations === Number.POSITIVE_INFINITY) return true;
        return a.playState === 'finished' || a.playState === 'idle';
      }),
    undefined,
    { timeout: 10_000 },
  );
}

test('capture editor screens', async ({ page }) => {
  // ① ログイン画面（入力前のきれいな状態）
  await page.goto('/login');
  await page.locator('#u').waitFor();
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('login.png'), animations: 'disabled' });

  await login(page, 'admin');

  // ①b パスワード変更画面。ログイン後にしか出せない（未認証だと現行パスワードを示せず、
  // フォーム自体が出ない仕様）。撮影後は編集タブへ戻して以降の導線を元の順序に保つ。
  await page.goto('/password-init');
  await page.locator('#c').waitFor();
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('password-init.png'), animations: 'disabled' });
  await page.goto('/edit');
  await page.getByText('ファンドコード').first().waitFor();
  await waitForLoaded(page);

  // ② 編集タブ（属性ドロップダウンが見える）
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('edit-tab.png'), animations: 'disabled' });

  // ②b テンプレート作成タブ
  // タブ間はリンククリックでなく `goto` で移る。クリックだとタブの `transition-colors` が走り、
  // 終了を待っても合成レイヤの解除が 1 フレーム遅れて丸い縁の反エイリアスが数階調ずれる
  // (`history-tab.png` で run の約半数。見た目は同じでも PNG のバイト列が変わる)。全再読込なら
  // トランジションが起きず、押した直後のホバー残りも写らない。
  // 会社・ファンド・版種を URL から復元し、Step 2 まで選べる状態を写す。
  // 作成済みのテンプレート(3 つ区切り)を置き、「既存のテンプレートを開く」が出る状態を写す。
  fs.mkdirSync(resolve(E2E_REST_DATA_ROOT, 'templates'), { recursive: true });
  fs.writeFileSync(
    resolve(E2E_REST_DATA_ROOT, 'templates', 'XX01_950037_交付版.html'),
    '<html><body><h1 class="report-title">{{ fund.name }}</h1></body></html>',
    'utf8',
  );
  await page.goto(
    `/create?companyCode=XX01&fundCode=950037&editionType=${encodeURIComponent('交付版')}`,
  );
  await page.getByText('作成するファンドを指定').first().waitFor();
  await expect(page.getByRole('button', { name: '既存のテンプレートを開く' })).toBeVisible();
  await waitForLoaded(page);
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('create-tab.png'), animations: 'disabled' });

  // ②c 比較タブ / 履歴タブ / 管理者画面
  // タブ固有の実データ要素(絞り込みバーの見出し・タブボタン・一覧行)を先に待ってから、
  // 一覧を持つ画面は `waitForLoaded` でスケルトンの消滅まで待って撮る。
  await page.goto('/compare');
  // 待つのは比較画面にしか無い見出し。絞り込みバーの「委託会社」はテンプレート作成画面にも
  // 出るため、それを待つと遷移前の画面のまま合格し、作成画面を写した compare-tab.png ができる。
  await page.getByText('ファイルの比較').first().waitFor();
  await waitForLoaded(page);
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('compare-tab.png'), animations: 'disabled' });
  await page.goto('/history');
  await page.getByRole('button', { name: '編集履歴' }).waitFor();
  await waitForLoaded(page);
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('history-tab.png'), animations: 'disabled' });
  await page.goto('/admin');
  await page.getByText('ユーザー管理').first().waitFor();
  // この画面はスケルトンを描画しないため waitForLoaded は無意味(常に 0 件で即完了扱いになる)。
  // seed の実データ(admin 行)が描画されたことを直接待つ。
  await page.getByText('admin', { exact: true }).first().waitFor();
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('admin-users.png'), animations: 'disabled' });

  // ③ 編集画面（seed テンプレを直接開く）
  const editorFrame = await openEditor(page, SEED_ID);
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('editor.png'), animations: 'disabled' });

  // ③b 左パネル: パーツを追加（分類カスケードとカタログが開いた状態）
  await page.getByText('パーツを追加', { exact: true }).click();
  // `PartCatalog` は onMounted でパーツ一覧を取得する。読み込み中は「読み込み中…」を
  // 出すので、その消滅(=一覧確定)を待つ。
  await expect(page.getByText('読み込み中…')).toHaveCount(0, { timeout: 10_000 });
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('editor-parts.png'), animations: 'disabled' });
  await page.getByText('パーツを追加', { exact: true }).click(); // 閉じて戻す

  // ③c 編集を許可 → キャンバス中程のブロックを選択してハンドルを見せる
  // (frame 内要素の boundingBox はページ座標で返るので、そのまま clip に使える)
  await page.getByText('編集を許可', { exact: true }).click();
  await expect(page.getByText('編集中', { exact: true })).toBeVisible({ timeout: 10_000 });
  const frame = editorFrame;
  const block = partLocator(frame).nth(2);
  // キャンバスの描画が終わる前に掴むと、ブロックが最終寸法になっておらず clip が
  // 小さく切れる(内容の欠けた画像がそのまま手引きへ載る)。可視化と寸法の確定を待つ。
  await block.waitFor({ state: 'visible', timeout: 30_000 });
  await waitForStableBox(page, block);
  await block.click();
  const box = await waitForStableBox(page, block);
  const pad = 70;
  await waitForTransitionsSettled(page);
  await page.screenshot({
    path: IMG('editor-handles.png'),
    animations: 'disabled',
    clip: box
      ? {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: box.width + pad * 2,
          height: box.height + pad * 2,
        }
      : undefined,
  });

  // ④ プレビュー画面
  // `@vivliostyle/core` は loadDocument 後も非同期にページを組版するため, 固定待ちでは
  // 本文が空(灰色)のまま撮れることがある。viewer が `viewport` に出力するページ要素
  // (`data-vivliostyle-page-container`)の出現を待ってから撮る。
  // 組版は opaque オリジンの隔離 iframe(`PreviewPanel.vue`)の中で走るため、待ち受けは
  // トップ文書ではなく `frameLocator` 越しに行う(トップで待つと 0 件のまま timeout する)。
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await waitForPreviewPage(page);
  await waitForStableBox(
    page,
    page
      .frameLocator('iframe[title="プレビュー"]')
      .locator('[data-vivliostyle-page-container]:visible')
      .first(),
  );
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('preview.png'), animations: 'disabled' });
});

// ── 承認タブと編集画面の変更の目印 ──
// 申請の本文は確定版の値入り HTML を 3 か所直したもの。表紙の本文の前に足した注記(①・追加。左の
// 紙面には空き枠)、表紙の本文の言い回し(②・変更)、運用コメントの言い回し(③・変更。4 ページ目)。
// 申請カードは高さを決めた枠(`ReviewDetail.vue` の作業域)なので、判定バーまで 1 枚に収まるよう
// 画面を縦に広げて撮る(900px では区画の下端が画面の外に出て、要素の撮影でも描かれない)。
// 申請日時はサーバが申請を受けた時刻(`reviewRepo` の `new Date()`)で付くので、撮り直すたびに
// 区画ヘッダの日時が変わり、承認画面の PNG は内容が同じでもバイト列が変わる。ブラウザ側の時刻を
// 固定しても日時は固定できず、`page.clock.setFixedTime` はプレビューの子フレームにも効いて
// @vivliostyle/core 2.45 の組版を止める(2.43 では止まらなかった)ので、時刻は固定しない。

const SEED_CSS = 'XX01_950037_交付版.css';
const REJECT_REASON = '運用コメントの言い回しは前回の確定版のまま残してください。';

/** `html` の中の `from` を 1 か所 `to` に置き換える(無ければ落とす。fixture が変わったときの検出)。 */
function replaceOnce(html: string, from: string, to: string): string {
  expect(html).toContain(from);
  return html.replace(from, to);
}

/** 3 か所を直した申請の本文。 */
function editedSeedHtml(): string {
  const base = fs.readFileSync(resolve(E2E_REST_DATA_ROOT, 'filled', `${SEED_ID}.html`), 'utf8');
  const cover = replaceOnce(base, '厚くお礼申しあげます', '心よりお礼申しあげます');
  const note = replaceOnce(
    cover,
    '<section class="cover_body">',
    '<section class="cover_note"><p>（注）本書の数値はすべて架空のものです。</p></section>\n    <section class="cover_body">',
  );
  return replaceOnce(note, '機動的に調整しました', '機動的に見直しました');
}

/** 表示中のページに描かれた番号札(ホストが page container の直下に描く)。 */
function paperBadge(frame: FrameLocator, no: number): Locator {
  return frame.locator(
    `[data-vivliostyle-page-container]:visible > [data-review-badge="no"][data-review-for="${no}"]`,
  );
}

/**
 * RTE でパラグラフ内の 1 語を置換する(`canvas.spec.ts` の `replaceWord` と同じ手順)。canvas 文書へ
 * 直接 dblclick を配送するのは、合成のダブルクリックが選択後のオーバーレイに 2 打目を吸われるため。
 */
async function replaceWord(
  page: Page,
  frame: FrameLocator,
  needle: string,
  from: string,
  to: string,
): Promise<void> {
  await frame.getByText(needle).first().click();
  await page.evaluate((n) => {
    const doc = document.querySelector<HTMLIFrameElement>('iframe.gjs-frame')?.contentDocument;
    const p = [...(doc?.querySelectorAll('p') ?? [])].find((e) =>
      (e.textContent ?? '').includes(n),
    );
    p?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, needle);
  const editing = frame.locator('[contenteditable="true"]').first();
  await expect(editing).toBeVisible({ timeout: 10_000 });
  await editing.evaluate(
    (el, [f, t]) => {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes(f))
          n.textContent = (n.textContent ?? '').replace(f, t);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    },
    [from, to],
  );
  await partLocator(frame)
    .first()
    .click({ position: { x: 5, y: 5 } });
}

test('capture review screens (申請 → 承認タブ → 判定 → 編集画面の目印)', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1200 });

  // editor が申請する(最終確定のあとに、同じ editor が編集画面で前回の却下の理由を読む)。
  const css = fs.readFileSync(resolve(E2E_REST_DATA_ROOT, 'css', SEED_CSS), 'utf8');
  await login(page, 'editor');
  await submitEditReviewViaApi(page, { templateId: SEED_ID, html: editedSeedHtml(), css });

  // approver で承認タブを `?template=` 付きで開く(先頭 1 件は既定で展開される)。
  await login(page, 'approver');
  await page.goto(`/reviews?template=${encodeURIComponent(SEED_ID)}`);
  await waitForLoaded(page);
  const item = page.locator('[data-review-item]').first();
  await item.waitFor();
  await waitForComparePapers(item);
  const { before, after } = comparePapers(item);
  await expect(decisionRow(item, 3)).toBeVisible({ timeout: 30_000 });
  await expect(paperBadge(after, 1)).toBeVisible({ timeout: 30_000 });

  // ①(追加した注記)を承認する(番号が緑になる)。②・③ は未判定のまま撮る。
  const saved = partDecisionsSaved(page);
  await decisionRow(item, 1).getByRole('button', { name: '承認', exact: true }).click();
  await saved;
  await expect(decisionRow(item, 1).locator('[data-review-no]')).toHaveAttribute(
    'data-decision',
    'approved',
  );
  await expect
    .poll(() => paperBadge(after, 1).evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe('rgb(47, 138, 95)');
  for (const f of [before, after]) {
    await waitForStableBox(page, f.locator('[data-vivliostyle-page-container]:visible').first());
  }
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('reviews-list.png'), animations: 'disabled' });
  await item.screenshot({ path: IMG('review-diff.png'), animations: 'disabled' });

  // ③ の行を押して紙面を ③ のページへ送り、「却下…」で開いた理由欄に書いた状態(保存前)を撮る。
  const row3 = decisionRow(item, 3);
  await row3.locator('[data-review-name]').click();
  await expect(paperBadge(after, 3)).toBeVisible({ timeout: 30_000 });
  await row3.getByRole('button', { name: '却下…', exact: true }).click();
  await row3.locator('textarea').fill(REJECT_REASON);
  // 理由欄の下端(「却下する」)まで右欄の中で見える位置へ送る。
  await row3.getByRole('button', { name: '却下する', exact: true }).scrollIntoViewIfNeeded();
  await waitForStableBox(page, after.locator('[data-vivliostyle-page-container]:visible').first());
  await waitForTransitionsSettled(page);
  await item.screenshot({ path: IMG('review-decide.png'), animations: 'disabled' });

  // ③ を却下し、② を承認して最終確定する(却下した ③ は現行版のまま確定される)。
  const rejected = partDecisionsSaved(page);
  await row3.getByRole('button', { name: '却下する', exact: true }).click();
  await rejected;
  await expect(row3.locator('[data-review-no]')).toHaveAttribute('data-decision', 'rejected');
  await approvePendingParts(page, item);
  await finalizeReview(page, item);
  // 決着した申請は既定の絞り込み(承認待ち)から外れる。承認待ちの件数が 0 になれば確定済み。
  await expect(chipCount(page, 'pending')).toHaveText('0', { timeout: 60_000 });

  // 編集画面は手引きのほかの画像と同じ高さで撮る。
  await page.setViewportSize({ width: 1440, height: 900 });

  // 申請者(editor)が編集画面を開き、表紙の 1 語を直す。直したパーツに ① が付き、却下された
  // 運用コメントには前回の却下の理由が出る。
  await login(page, 'editor');
  const frame = await openEditor(page, SEED_ID);
  await expect(page.locator('[data-rejected-reason]').first()).toContainText(REJECT_REASON, {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: '閲覧のみ(クリックで編集を許可)' }).click();
  await replaceWord(page, frame, '受益者のみなさまへ', 'みなさま', '皆様');
  const markers = page.locator('[data-change-marker]');
  await expect(markers).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('header [role="status"]')).toHaveAttribute('title', /に自動保存/, {
    timeout: 15_000,
  });

  // 選択は永続しないので、再読み込みで未選択に戻し、「修正履歴（全パーツ）」の見出しを出す。
  page.on('dialog', (d) => void d.accept());
  await page.reload({ waitUntil: 'commit' });
  const reloaded = page.frameLocator('iframe.gjs-frame');
  await partLocator(reloaded).first().waitFor({ state: 'visible', timeout: 30_000 });
  await expect(markers).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('[data-history-heading]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-rejected-reason]').first()).toContainText(REJECT_REASON, {
    timeout: 30_000,
  });
  // 修正履歴は e2e サーバの実行ごとの `.tmp/e2e-rest-logs`(起動時に消す)に積まれるので、過去の
  // 実行の分は写らない。① の見出しと却下の理由の枠が両方見えるよう、見出しを右ペインの先頭へ送る。
  await page
    .locator('[data-history-heading]')
    .first()
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await waitForStableBox(page, markers.first());
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('editor-marks.png'), animations: 'disabled' });
});
