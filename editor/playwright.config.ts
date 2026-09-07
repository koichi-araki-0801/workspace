import { fileURLToPath, URL } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// `E2E_REST=1` は呼び出し元のシェルで設定する(`$env:E2E_REST='1'; pnpm run e2e:rest` /
// `E2E_REST=1 pnpm run e2e:rest`)。npm script 側で `VAR=val cmd` と前置きしないのは、
// Windows の pnpm script が cmd.exe 経由で走り、この構文が解釈されないため。`CI` と同じ
// 「外側の env をそのまま読む」方式に揃える。
const REST = process.env.E2E_REST === '1';

/**
 * E2E config. The default projects (chromium/docs) run against the web SPA (localApi +
 * localStorage) on the local servers (24680/24681): the domain data still comes from
 * fixtures, not from the backend.
 *
 * The Fastify server is booted all the same, because the preview screen renders inside an
 * isolated iframe whose page (`/api/preview-host/index.html`) is served by the server —
 * that route needs its own CSP, which only a real HTTP response can carry (see
 * `server/src/vivliostyle/previewHost.ts`). Without it the preview falls back to the plain
 * iframe and the docs screenshot no longer shows a typeset page. Vite proxies `/api` to it.
 *
 * `E2E_REST=1` のときだけ project `rest` が加わり、24690/24691 の別サーバ(sproc フェイク +
 * 一時 dataRoot)を自前で起動して走る。ポートを分けるのは、開発中の local サーバが 24680 に
 * 居るとヘルスチェックが通ってしまい rest spec が local 経路で走る事故を防ぐため。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // retry は使わない: 状態待ちへ揃えた後の flake は「たまたま通った」で隠さず、
  // CI で毎回顕在化させて直す対象にする(waitForTimeout 撤去のゴール)。
  retries: 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: REST ? 'http://localhost:24691' : 'http://localhost:24681',
    // retries: 0 では「初回失敗」の trace を残さないと再現の手掛かりが無くなるため retain-on-failure にする。
    trace: 'retain-on-failure',
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
    ...(REST
      ? [
          {
            // sproc フェイク + 一時 dataRoot を相手にする rest 経路の最小回帰網(`e2e:rest`)。
            // `workers: 1` はログインが並列に集中して `loginRateLimit` に当たるのを避けるため
            // (承認フローは editor→approver の 2 名を直列に使う)。
            name: 'rest',
            testMatch: '**/*.rest.spec.ts',
            use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:24691' },
            workers: 1,
          },
        ]
      : []),
  ],
  webServer: REST
    ? [
        {
          command: 'pnpm --filter server exec tsx scripts/e2e-rest-server.ts',
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          // ヘルスチェック先を `127.0.0.1` で書くのは、このサーバが `HOST=127.0.0.1` で
          // 待つため(`localhost` は環境により `::1` へ解決されて到達しない)。
          url: 'http://127.0.0.1:24690/api/health',
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: 'pnpm --filter web exec vite --port 24691',
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          // `VITE_API_MODE=rest` で web が REST リポジトリ(`api/rest/*`)を選ぶ(`main.ts`)。
          // `API_PROXY_TARGET` は vite.config.ts の proxy 先の上書き。
          env: { VITE_API_MODE: 'rest', API_PROXY_TARGET: 'http://127.0.0.1:24690' },
          url: 'http://localhost:24691',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ]
    : [
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
