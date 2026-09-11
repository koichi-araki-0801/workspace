import { fileURLToPath, URL } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { E2E_REST_WEB_PORT } from './server/scripts/e2e-rest-paths';

/** Vite dev の待受。定数を e2e サーバ側と共有し、片方だけ動いてずれる形を作らない。 */
const webUrl = `http://localhost:${E2E_REST_WEB_PORT}`;

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
  // 全 project が 1 台のサーバと 1 つの一時 dataRoot を共有し、`e2e/fixtures.ts` が
  // テストごとにそれを `rm -rf` して作り直す。直列でなければ片方のリセットがもう片方の
  // 申請・下書きを実行中に消し、fixture の module-level `lastFile` も worker ごとに
  // 別値になって効かない。ログインが並列に集中して `loginRateLimit` に当たるのも防ぐ
  // (承認フローは admin→approver の 2 名を直列に使う)。`fullyParallel` が無害なのは
  // これがあるからで、外すときは両方を一緒に考えること。
  workers: 1,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // retry は使わない: 状態待ちへ揃えた後の flake は「たまたま通った」で隠さず、
  // CI で毎回顕在化させて直す対象にする(waitForTimeout 撤去のゴール)。
  retries: 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: webUrl,
    // retries: 0 では「初回失敗」の trace を残さないと再現の手掛かりが無くなるため retain-on-failure にする。
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // 挙動を検証する spec 全部。`test:e2e`(`ci` と GitHub Actions)と `e2e:editor` の両方で走る。
      // `capture_docs.spec.ts` を外すのは、あの spec が git 管理下の `docs/editor/images/*.png` を
      // 書き換えるため。フル `ci` / GH の結果としてリポジトリの成果物が変わるのは検査ではない。
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/capture_docs.spec.ts'],
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
      // 起動途中で落ちたときに終了時の出力が要る(既定の 'ignore' では原因が残らない)。
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    },
    {
      command: `pnpm --filter web exec vite --port ${E2E_REST_WEB_PORT}`,
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // `VITE_API_MODE=rest` は既定と同じだが、呼び出し元シェルの `local` 指定に引きずられない
      // よう明示する。`API_PROXY_TARGET` は vite.config.ts の proxy 先の上書き。
      env: { VITE_API_MODE: 'rest', API_PROXY_TARGET: 'http://127.0.0.1:24680' },
      url: webUrl,
      reuseExistingServer: false,
      // Vite は実行中に黙って落ちたことがある。終了時の出力を捕まえて原因を残す。
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    },
  ],
});
