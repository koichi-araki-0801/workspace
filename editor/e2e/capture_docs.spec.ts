// =============================================================================
// capture_docs.spec.ts — 操作手順書(docs/editor)向けスクリーンショット取得
// =============================================================================
// 実行は editor 配下で:
//   pnpm exec playwright test e2e/capture_docs.spec.ts
// `playwright.config.ts` の webServer が Vite dev(:5173, ローカル/ localStorage モード)
// を自動起動する。ログイン後はセッションが localStorage に乗るので、編集/プレビューは
// seed テンプレ(AM01_510037_20240710_交付版)へ直接遷移して撮る。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = (name: string) => resolve(here, '../../docs/editor/images', name);
const SEED_ID = 'AM01_510037_20240710_交付版';

test.use({ viewport: { width: 1440, height: 900 } });

test('capture editor screens', async ({ page }) => {
  // ① ログイン画面（入力前のきれいな状態）
  await page.goto('/login');
  await page.locator('#u').waitFor();
  await page.screenshot({ path: IMG('login.png') });

  // ログイン → 編集タブへ
  await page.locator('#u').fill('admin');
  await page.locator('#p').fill('admin');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/edit/);
  await page.waitForTimeout(800);

  // ② 編集タブ（属性ドロップダウンが見える）
  await page.screenshot({ path: IMG('edit-tab.png') });

  // ③ 編集画面（seed テンプレを直接開く）
  await page.goto(`/edit/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(2500); // GrapesJS の初期化・キャンバス描画を待つ
  await page.screenshot({ path: IMG('editor.png') });

  // ④ プレビュー画面
  await page.goto(`/preview/${encodeURIComponent(SEED_ID)}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: IMG('preview.png') });
});
