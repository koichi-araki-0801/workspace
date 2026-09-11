// =============================================================================
// e2e-rest-seed.ts — e2e の一時 dataRoot を fixtures から作り直す(副作用なしの関数)
// =============================================================================
// 起動スクリプト(`e2e-rest-server.ts`)から分けてあるのは、あちらが import しただけで
// env を書き換え・dataRoot を消して作り直し・ポートを掴むため。Playwright 側の fixture
// (`editor/e2e/fixtures.ts`)は spec ファイルごとに同じ seed をやり直す必要があり、
// 起動スクリプトを import すると走っているサーバを巻き添えにする。ここは呼ばれたときだけ
// 働く関数 1 本を持つ。

import fs from 'node:fs/promises';
import path from 'node:path';
import { E2E_REST_DATA_ROOT } from './e2e-rest-paths.js';

/**
 * dataRoot をファイルで seed する。一覧・1 件取得・申請はファイル走査(台帳ではない。
 * `templateRepo.ts` / `reviewRepo.ts` を見よ)なので、確定 template と per-fund CSS を
 * 置くだけで一覧・編集・申請・承認が成立する。`reviews` / `notes` / `drafts` / `pending`
 * ディレクトリは各リポジトリの書込側が `mkdir(..., { recursive: true })` するため
 * 事前作成は不要。git リポジトリ化(`ensureRepo`)も承認時に自動で行われるため不要。
 */
export async function seedDataRoot(repoRoot: string): Promise<void> {
  await fs.rm(E2E_REST_DATA_ROOT, { recursive: true, force: true });
  const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
  const cssDir = path.join(E2E_REST_DATA_ROOT, 'css');
  const filledDir = path.join(E2E_REST_DATA_ROOT, 'filled');
  await fs.mkdir(templatesDir, { recursive: true });
  await fs.mkdir(cssDir, { recursive: true });
  await fs.mkdir(filledDir, { recursive: true });

  const fixturesTemplatesDir = path.join(repoRoot, 'editor/web/src/api/fixtures/templates');
  const fixturesCssDir = path.join(repoRoot, 'editor/web/src/api/fixtures/css');
  // 編集タブの一覧は filled/ が源。値入り HTML の seed は web 同梱の round-trip 形式 fixture
  // (`{%` を含まない)をそのまま使う。
  const fixturesFilledDir = path.join(repoRoot, 'editor/web/src/api/fixtures/filled');
  for (const name of await fs.readdir(fixturesTemplatesDir)) {
    await fs.copyFile(path.join(fixturesTemplatesDir, name), path.join(templatesDir, name));
  }
  for (const name of await fs.readdir(fixturesCssDir)) {
    await fs.copyFile(path.join(fixturesCssDir, name), path.join(cssDir, name));
  }
  for (const name of await fs.readdir(fixturesFilledDir)) {
    await fs.copyFile(path.join(fixturesFilledDir, name), path.join(filledDir, name));
  }
}
