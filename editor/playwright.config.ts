import { fileURLToPath, URL } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Tests run against the web SPA (localApi + localStorage): the domain data
 * still comes from fixtures, not from the backend.
 *
 * The Fastify server is booted all the same, because the preview screen renders inside an
 * isolated iframe whose page (`/api/preview-host/index.html`) is served by the server —
 * that route needs its own CSP, which only a real HTTP response can carry (see
 * `server/src/vivliostyle/previewHost.ts`). Without it the preview falls back to the plain
 * iframe and the docs screenshot no longer shows a typeset page. Vite proxies `/api` to it.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:24681',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // 挙動を検証する spec 全部。`test:e2e`(`ci` と GitHub Actions)と `e2e:editor` の両方で走る。
      // `capture_docs.spec.ts` を外すのは、あの spec が git 管理下の `docs/editor/images/*.png` を
      // 書き換えるため。フル `ci` / GH の結果としてリポジトリの成果物が変わるのは検査ではない。
      // `*.rest.spec.ts` は SQL Server 相当のフェイクを立てる `rest` project(`E2E_REST=1` の
      // ときだけ `projects` に入る)の担当で、local 経路のサーバ相手に走らせると意味が変わる。
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/capture_docs.spec.ts', '**/*.rest.spec.ts'],
    },
    {
      // 操作手引き(docs/editor)のスクリーンショットを撮り直す project。`e2e:editor`(`ci:affected`
      // の editor 領域)だけが `--project docs` で選ぶ。editor に触れた push でだけ再撮影が走り、
      // 差分は「再撮影」としてコミットする。
      name: 'docs',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/capture_docs.spec.ts',
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter server run dev',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      url: 'http://localhost:24680/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter web run dev',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      url: 'http://localhost:24681',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
