// =============================================================================
// capture_docs.spec.ts — 操作手順書(docs/editor)向けスクリーンショット取得
// =============================================================================
// 実行は editor 配下で:
//   pnpm exec playwright test e2e/capture_docs.spec.ts
// `playwright.config.ts` の webServer が Vite dev(:5173, ローカル/ localStorage モード)
// を自動起動する。ログイン後はセッションが localStorage に乗るので、編集/プレビューは
// seed テンプレ(AM01_510037_20240710_交付版)へ直接遷移して撮る。
// 承認系(reviews-list/review-diff)は「admin で申請 → approver で精査」を同一
// コンテキスト(localStorage 共有)内で通しで再現する。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = (name: string) => resolve(here, '../../docs/editor/images', name);
const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page, user: string, pass: string) {
  await page.goto('/login');
  await page.locator('#u').waitFor();
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(pass);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/(edit|reviews)/);
  await page.waitForTimeout(800);
}

test('capture editor screens', async ({ page }) => {
  // ① ログイン画面（入力前のきれいな状態）
  await page.goto('/login');
  await page.locator('#u').waitFor();
  await page.screenshot({ path: IMG('login.png') });

  // ①b パスワード初期設定画面（初回ログイン時に出る画面。public ルートを直接開く）
  await page.goto('/password-init?username=editor');
  await page.locator('#n').waitFor();
  await page.screenshot({ path: IMG('password-init.png') });

  await login(page, 'admin', 'admin');

  // ② 編集タブ（属性ドロップダウンが見える）
  await page.screenshot({ path: IMG('edit-tab.png') });

  // ②b テンプレート作成タブ
  await page.getByRole('link', { name: 'テンプレート作成' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: IMG('create-tab.png') });

  // ②c 比較タブ / 履歴タブ / 管理者画面
  await page.getByRole('link', { name: '比較' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: IMG('compare-tab.png') });
  await page.getByRole('link', { name: '履歴' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: IMG('history-tab.png') });
  await page.getByRole('link', { name: '管理者' }).click();
  await page.waitForTimeout(600);
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
  await block.click();
  await page.waitForTimeout(600);
  const box = await block.boundingBox();
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
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await page.locator('[data-vivliostyle-page-container]').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(500); // 組版確定後の微小な再レイアウトを吸収する
  await page.screenshot({ path: IMG('preview.png') });
});

test('capture review screens (申請 → 承認キュー → 精査)', async ({ page }) => {
  // admin で申請を 1 件作る（editor は初回 PW 変更が挟まるため admin で代用）。
  // 無編集の申請なので精査画面は「変更なしも表示」を入れて、パーツ行
  // (変更前｜変更後) のレイアウトが写る状態で撮る。
  await login(page, 'admin', 'admin');
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await page.locator('[data-vivliostyle-page-container]').first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '確定保存を申請' }).click();
  await page.getByRole('button', { name: '申請する' }).click();
  await page.waitForTimeout(1000);

  // approver で入り直して承認キューを撮る（同一 localStorage なので申請が見える）
  await login(page, 'approver', 'approver');
  await page.getByRole('link', { name: '承認' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: IMG('reviews-list.png') });

  // 精査画面（変更前｜変更後のパーツ行）
  await page.getByRole('button', { name: '精査する' }).first().click();
  await page.waitForTimeout(2000); // diff 計算と srcdoc iframe の描画を待つ
  await page.getByText('変更なしも表示').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: IMG('review-diff.png') });
});
