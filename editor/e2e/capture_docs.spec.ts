// =============================================================================
// capture_docs.spec.ts — 操作手順書(docs/editor)向けスクリーンショット取得
// =============================================================================
// 実行は editor 配下で(`docs` project だけが本 spec を担当し、`chromium` は ignore する):
//   pnpm exec playwright test --project docs
// `playwright.config.ts` の webServer が Vite dev(:24681, ローカル/ localStorage モード)
// を自動起動する。ログイン後はセッションが localStorage に乗るので、編集/プレビューは
// seed テンプレ(AM01_510037_20240710_交付版)へ直接遷移して撮る。
// 承認系(reviews-list/review-diff)は「admin で申請 → approver で承認タブを開く」を同一
// コンテキスト(localStorage 共有)内で通しで再現する。
// 撮影は `animations: 'disabled'` で行う。スピナーの回転角やタブ切替のトランジション途中が
// 写ると、内容が同じでもバイト列が run ごとに変わり、pre-push の再撮影が毎回作業ツリーを汚す。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { login, openEditor, waitForLoaded, waitForStableBox } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = (name: string) => resolve(here, '../../docs/editor/images', name);
const SEED_ID = 'AM01_510037_20240710_交付版';

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
  await page.getByText('委託会社コード').first().waitFor();
  await waitForLoaded(page);

  // ② 編集タブ（属性ドロップダウンが見える）
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('edit-tab.png'), animations: 'disabled' });

  // ②b テンプレート作成タブ
  // タブ間はリンククリックでなく `goto` で移る。クリックだとタブの `transition-colors` が走り、
  // 終了を待っても合成レイヤの解除が 1 フレーム遅れて丸い縁の反エイリアスが数階調ずれる
  // (`history-tab.png` で run の約半数。見た目は同じでも PNG のバイト列が変わる)。全再読込なら
  // トランジションが起きず、押した直後のホバー残りも写らない。
  await page.goto('/create');
  await page.getByText('作成するファンドを指定').first().waitFor();
  await waitForLoaded(page);
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('create-tab.png'), animations: 'disabled' });

  // ②c 比較タブ / 履歴タブ / 管理者画面
  // タブ固有の実データ要素(絞り込みバーの見出し・タブボタン・一覧行)を先に待ってから、
  // 一覧を持つ画面は `waitForLoaded` でスケルトンの消滅まで待って撮る。
  await page.goto('/compare');
  // 待つのは比較画面にしか無い見出し。絞り込みバーの「委託会社コード」はテンプレート作成画面にも
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
  const block = frame.locator('.page > *').nth(2);
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

test('capture review screens (申請 → 承認タブ → 精査)', async ({ page }) => {
  // 申請日時は `new Date()` の実時刻で描かれるので、撮り直すたびに分が進んで PNG のバイト列が
  // 変わる(内容は同じでも作業ツリーが汚れる)。撮影の間だけ時刻を固定する。`setFixedTime` は
  // `Date` の返す値だけを固定してタイマーは通常どおり走らせるため、`install` と違って
  // プレビュー組版の非同期処理を止めない。
  // オフセットを明示する。指定が無いと実行機の地方時として解釈され、撮影する画面の時刻表示が
  // 環境で変わる(バイト一致の前提が崩れる)。
  await page.clock.setFixedTime(new Date('2026-07-10T11:42:00+09:00'));

  // admin で申請を 1 件作る（editor は初回 PW 変更が挟まるため admin で代用）。
  // 無編集の申請でも精査画面の既定タブ（見た目で比較）は前後の組版を並べて表示できる。
  await login(page, 'admin');
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await waitForPreviewPage(page);
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '確定保存を申請しました' }),
  ).toBeVisible();

  // approver で入り直し、承認タブを対象テンプレートで開く(編集タブで開いたテンプレートの
  // 申請を縦に並べる画面。先頭 1 件は既定で展開される)
  await login(page, 'approver');
  await page.goto(`/reviews?template=${encodeURIComponent(SEED_ID)}`);
  await waitForLoaded(page);
  await page.locator('[data-review-item]').first().waitFor();
  // 展開区画の組版(前後 2 面)を待ってから、要約箱と区画ヘッダが入る全体を撮る
  const compareFirst = page
    .frameLocator('iframe[title="プレビュー"]')
    .first()
    .locator('[data-vivliostyle-page-container]:visible')
    .first();
  const compareSecond = page
    .frameLocator('iframe[title="プレビュー"]')
    .nth(1)
    .locator('[data-vivliostyle-page-container]:visible')
    .first();
  await compareFirst.waitFor({ state: 'visible', timeout: 60_000 });
  await compareSecond.waitFor({ state: 'visible', timeout: 60_000 });
  await waitForStableBox(page, compareFirst);
  await waitForStableBox(page, compareSecond);
  await waitForTransitionsSettled(page);
  await page.screenshot({ path: IMG('reviews-list.png'), animations: 'disabled' });

  // 展開区画(見た目比較 + コメントパネル)を切り出して撮る
  const section = page.locator('[data-review-item]').first();
  await waitForTransitionsSettled(page);
  await section.screenshot({ path: IMG('review-diff.png'), animations: 'disabled' });
});
