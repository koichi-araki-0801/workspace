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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
