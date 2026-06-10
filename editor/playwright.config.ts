import { fileURLToPath, URL } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Tests run against the web SPA (localApi + localStorage),
 * so no backend is required. Playwright boots the Vite dev server itself.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter web run dev',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
