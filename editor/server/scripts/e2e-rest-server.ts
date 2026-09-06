// =============================================================================
// e2e-rest-server.ts — rest e2e(playwright project `rest`)専用のサーバ起動エントリ
// =============================================================================
// `E2E_REST=1` のときだけ playwright.config.ts が webServer として起動する。
// `config.ts` は import 時に `process.env` を解決するため、`PORT` 等は `serve.ts` の
// 動的 import より前に設定する(静的 import では一時 `DATA_ROOT` が効かない)。
// dataRoot はリポジトリ内の gitignore 済み固定パス(`.tmp/e2e-rest-dataroot`)を毎回
// 作り直して使う — `os.tmpdir()` の乱数ディレクトリだと、テスト側が「今回起動した分」を
// prefix 走査で推測する必要が生まれ、前回異常終了の残骸と混同しうるため。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

/** rest e2e の dataRoot。テスト側(fixture)も同じ式で再計算して参照する。 */
export const E2E_REST_DATA_ROOT = path.join(repoRoot, '.tmp', 'e2e-rest-dataroot');

// loopback かつ非 production なので `assertSafeExposure` は素通しし、`cookieSecure` は
// 既定の false になる(平文 HTTP でセッション cookie が落ちない)。`AUDIT_DB=true` は
// 監査ログの sproc 経路をフェイク越しに実際へ通すため。
process.env.PORT = '24690';
process.env.HOST = '127.0.0.1';
process.env.AUTH_REQUIRED = 'true';
process.env.AUDIT_DB = 'true';
process.env.DATA_ROOT = E2E_REST_DATA_ROOT;

/**
 * dataRoot をファイルで seed する。一覧・1 件取得・申請はファイル走査(台帳ではない。
 * `templateRepo.ts` / `reviewRepo.ts` を見よ)なので、確定 template と per-fund CSS を
 * 置くだけで一覧・編集・申請・承認が成立する。`reviews` / `notes` / `drafts` / `pending`
 * ディレクトリは各リポジトリの書込側が `mkdir(..., { recursive: true })` するため
 * 事前作成は不要。git リポジトリ化(`ensureRepo`)も承認時に自動で行われるため不要。
 */
async function seedDataRoot(): Promise<void> {
  await fs.rm(E2E_REST_DATA_ROOT, { recursive: true, force: true });
  const templatesDir = path.join(E2E_REST_DATA_ROOT, 'templates');
  const cssDir = path.join(E2E_REST_DATA_ROOT, 'css');
  await fs.mkdir(templatesDir, { recursive: true });
  await fs.mkdir(cssDir, { recursive: true });

  const fixturesTemplatesDir = path.join(repoRoot, 'editor/web/src/api/fixtures/templates');
  const fixturesCssDir = path.join(repoRoot, 'editor/web/src/api/fixtures/css');
  for (const name of await fs.readdir(fixturesTemplatesDir)) {
    await fs.copyFile(path.join(fixturesTemplatesDir, name), path.join(templatesDir, name));
  }
  for (const name of await fs.readdir(fixturesCssDir)) {
    await fs.copyFile(path.join(fixturesCssDir, name), path.join(cssDir, name));
  }
}

await seedDataRoot();

// `config.ts` が import 時に上記の env を読むため、`serve.ts` は動的 import で遅らせる。
const { createSprocClient } = await import('../src/db/sproc.js');
const { createFakeQuery } = await import('../test/fakes/sprocFake.js');
const { startServer } = await import('../src/serve.js');

await startServer({ sproc: createSprocClient(await createFakeQuery()) });
console.log(
  `[e2e-rest-server] listening on http://127.0.0.1:24690 (dataRoot=${E2E_REST_DATA_ROOT})`,
);
