import { fileURLToPath, URL } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. 既定 project(chromium/docs)は sproc フェイク + 一時 dataRoot のサーバ(24680)と
 * Vite(24681)を自前で起動して走る。SQL Server は不要。
 *
 * Fastify サーバを必ず立てるのは、ドメインデータの供給元であることに加えて、プレビュー画面が
 * 隔離 iframe の中で組版するため — そのページ(`/api/preview-host/index.html`)は経路専用 CSP を
 * 持つ実 HTTP 応答でしか配れない(`server/src/vivliostyle/previewHost.ts`)。無いとプレビューは
 * 素の iframe へ退行し、docs のスクリーンショットに組版済みページが写らない。Vite が `/api` を
 * このサーバへ proxy する。
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
    baseURL: 'http://localhost:24681',
    // retries: 0 では「初回失敗」の trace を残さないと再現の手掛かりが無くなるため retain-on-failure にする。
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // 挙動を検証する spec 全部。`test:e2e`(`ci` と GitHub Actions)と `e2e:editor` の両方で走る。
      // `capture_docs.spec.ts` を外すのは、あの spec が git 管理下の `docs/editor/images/*.png` を
      // 書き換えるため。フル `ci` / GH の結果としてリポジトリの成果物が変わるのは検査ではない。
      // `workers: 1` はログインが並列に集中して `loginRateLimit` に当たるのを避けるため
      // (承認フローは admin→approver の 2 名を直列に使う)。
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/capture_docs.spec.ts'],
      workers: 1,
    },
    {
      // 操作手引き(docs/editor)のスクリーンショットを撮り直す project。`e2e:editor`(`ci:affected`
      // の editor 領域)だけが `--project docs` で選ぶ。editor に触れた push でだけ再撮影が走り、
      // 差分は「再撮影」としてコミットする。
      name: 'docs',
      // `timezoneId` は撮影する画面の時刻表示を固定するため。`capture_docs.spec.ts` の
      // `setFixedTime` が固定するのは瞬間だけで、表示は `Date` のローカル getter 経由=
      // ブラウザの地方時で組み立てられる。両方を固定して初めて PNG がバイト一致する。
      use: { ...devices['Desktop Chrome'], timezoneId: 'Asia/Tokyo' },
      testMatch: '**/capture_docs.spec.ts',
      // `workers: 1` は chromium と同じく必須。テストごとに一時 dataRoot を作り直す
      // (`e2e/fixtures.ts`)ので、並列だと片方のリセットがもう片方の申請・下書きを消す。
      workers: 1,
    },
  ],
  webServer: [
    {
      // sproc フェイク + 一時 dataRoot(`<repo>/.tmp/e2e-rest-dataroot`)を毎回作り直して
      // 24680 で待つ。開発中の実サーバを使い回さない(実 DB・実 dataRoot を汚さない)。
      command: 'pnpm --filter server exec tsx scripts/e2e-rest-server.ts',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // ヘルスチェック先を `127.0.0.1` で書くのは、このサーバが `HOST=127.0.0.1` で待つため
      // (`localhost` は環境により `::1` へ解決されて到達しない)。
      url: 'http://127.0.0.1:24680/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter web exec vite --port 24681',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // `VITE_API_MODE=rest` は既定と同じだが、呼び出し元シェルの `local` 指定に引きずられない
      // よう明示する。`API_PROXY_TARGET` は vite.config.ts の proxy 先の上書き。
      env: { VITE_API_MODE: 'rest', API_PROXY_TARGET: 'http://127.0.0.1:24680' },
      url: 'http://localhost:24681',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
