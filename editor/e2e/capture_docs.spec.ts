// =============================================================================
// capture_docs.spec.ts — 操作手順書(docs/editor)向けスクリーンショット取得
// =============================================================================
// 実行は editor 配下で:
//   pnpm exec playwright test e2e/capture_docs.spec.ts
// `playwright.config.ts` の webServer が Vite dev(:24681, ローカル/ localStorage モード)
// を自動起動する。ログイン後はセッションが localStorage に乗るので、編集/プレビューは
// seed テンプレ(AM01_510037_20240710_交付版)へ直接遷移して撮る。
// 承認系(reviews-list/review-diff)は「admin で申請 → approver で承認タブを開く」を同一
// コンテキスト(localStorage 共有)内で通しで再現する。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = (name: string) => resolve(here, '../../docs/editor/images', name);
const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page, user: string, pass: string) {
  // 認証済みのままログイン画面へ行くと guard がアプリへ戻す。別ユーザーで入り直す撮影
  // フローがあるので、セッションだけ捨ててから入る(申請などの localStorage は残す)。
  // `waitUntil: 'commit'` は `canvas.spec.ts` の `openEditor` と同じ理由: 既定の 'load' は
  // 全サブリソースを待つので、SPA が起動時に出す認証確認や router のリダイレクトが割り込むと
  // `net::ERR_ABORTED` で goto 自体が落ちる。さらに、その遷移が終わる前に `evaluate` を投げると
  // 実行コンテキストごと壊れるため、URL が落ち着くまで待ってから localStorage を触る
  // (どちらも 4 並列の pre-push CI で実際に踏んだ)。
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForURL(/\/(login|edit|reviews)/);
  await page.evaluate(() => localStorage.removeItem('editor:session'));
  await page.goto('/login', { waitUntil: 'commit' });
  await page.locator('#u').waitFor();
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(pass);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  await page.waitForTimeout(800);
}

/**
 * ロード中のスケルトンが消えるまで待つ。固定時間の待ちだけでは、データ取得が間に合わず
 * **プレースホルダのまま**撮れることがある(履歴タブで実際に起き、読み込み中の画面が
 * 手引き HTML へ base64 で埋め込まれた)。撮影は緑のまま通るので CI では検出できない。
 * `animate-pulse` を持つのは `Skeleton.vue` だけなので、0 件 = 実データの描画完了。
 */
async function waitForLoaded(page: Page) {
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
}

/**
 * 要素の寸法が落ち着くまで待ち、その boundingBox を返す。可視化を待つだけでは足りない:
 * canvas のフォントが載る前は行の高さが確定せず、その寸法で `clip` を取ると**内容が
 * 途中で切れた**画像になる(CI の並列実行下で実際に起きた。単独実行では再現しない)。
 * 連続 2 回同じ寸法になったところを確定と見なす。
 */
async function waitForStableBox(page: Page, locator: Locator, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let previous = '';
  while (Date.now() < deadline) {
    const box = await locator.boundingBox();
    const key = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '';
    if (key && key === previous) return box;
    previous = key;
    await page.waitForTimeout(300);
  }
  return locator.boundingBox();
}

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

test('capture editor screens', async ({ page }) => {
  // ① ログイン画面（入力前のきれいな状態）
  await page.goto('/login');
  await page.locator('#u').waitFor();
  await page.screenshot({ path: IMG('login.png') });

  await login(page, 'admin', 'admin');

  // ①b パスワード変更画面。ログイン後にしか出せない（未認証だと現行パスワードを示せず、
  // フォーム自体が出ない仕様）。撮影後は編集タブへ戻して以降の導線を元の順序に保つ。
  await page.goto('/password-init');
  await page.locator('#c').waitFor();
  await page.screenshot({ path: IMG('password-init.png') });
  await page.goto('/edit');
  await page.waitForTimeout(600);
  await waitForLoaded(page);

  // ② 編集タブ（属性ドロップダウンが見える）
  await page.screenshot({ path: IMG('edit-tab.png') });

  // ②b テンプレート作成タブ
  await page.getByRole('link', { name: 'テンプレート作成' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  await page.screenshot({ path: IMG('create-tab.png') });

  // ②c 比較タブ / 履歴タブ / 管理者画面
  // 固定待ちはタブ遷移のアニメーションを吸収するためのもので、データの到着は保証しない。
  // 一覧を持つ画面は `waitForLoaded` でスケルトンの消滅まで待ってから撮る。
  await page.getByRole('link', { name: '比較' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  await page.screenshot({ path: IMG('compare-tab.png') });
  await page.getByRole('link', { name: '履歴' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  await page.screenshot({ path: IMG('history-tab.png') });
  await page.getByRole('link', { name: '管理者' }).click();
  await page.waitForTimeout(600);
  await waitForLoaded(page);
  await page.screenshot({ path: IMG('admin-users.png') });

  // ③ 編集画面（seed テンプレを直接開く）
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(2500); // GrapesJS の初期化・キャンバス描画を待つ
  await page.screenshot({ path: IMG('editor.png') });

  // ③b 左パネル: パーツを追加（分類カスケードとカタログが開いた状態）
  await page.getByText('パーツを追加', { exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: IMG('editor-parts.png') });
  await page.getByText('パーツを追加', { exact: true }).click(); // 閉じて戻す

  // ③c 編集を許可 → キャンバス中程のブロックを選択してハンドルを見せる
  // (frame 内要素の boundingBox はページ座標で返るので、そのまま clip に使える)
  await page.getByText('編集を許可', { exact: true }).click();
  await page.waitForTimeout(400);
  const frame = page.frameLocator('iframe.gjs-frame');
  const block = frame.locator('.page > *').nth(2);
  // キャンバスの描画が終わる前に掴むと、ブロックが最終寸法になっておらず clip が
  // 小さく切れる(内容の欠けた画像がそのまま手引きへ載る)。可視化と寸法の確定を待つ。
  await block.waitFor({ state: 'visible', timeout: 30_000 });
  await waitForStableBox(page, block);
  await block.click();
  await page.waitForTimeout(600);
  const box = await waitForStableBox(page, block);
  const pad = 70;
  await page.screenshot({
    path: IMG('editor-handles.png'),
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
  await page.waitForTimeout(500); // 組版確定後の微小な再レイアウトを吸収する
  await page.screenshot({ path: IMG('preview.png') });
});

test('capture review screens (申請 → 承認タブ → 精査)', async ({ page }) => {
  // admin で申請を 1 件作る（editor は初回 PW 変更が挟まるため admin で代用）。
  // 無編集の申請でも精査画面の既定タブ（見た目で比較）は前後の組版を並べて表示できる。
  await login(page, 'admin', 'admin');
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await waitForPreviewPage(page);
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await page.waitForTimeout(1000);

  // approver で入り直し、承認タブを対象テンプレートで開く(編集タブで開いたテンプレートの
  // 申請を縦に並べる画面。先頭 1 件は既定で展開される)
  await login(page, 'approver', 'approver');
  await page.goto(`/reviews?template=${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(800);
  await waitForLoaded(page);
  await page.locator('[data-review-item]').first().waitFor();
  // 展開区画の組版(前後 2 面)を待ってから、要約箱と区画ヘッダが入る全体を撮る
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .first()
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page
    .frameLocator('iframe[title="プレビュー"]')
    .nth(1)
    .locator('[data-vivliostyle-page-container]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: IMG('reviews-list.png') });

  // 展開区画(見た目比較 + コメントパネル)を切り出して撮る
  const section = page.locator('[data-review-item]').first();
  await section.screenshot({ path: IMG('review-diff.png') });
});
