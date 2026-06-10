import { defineConfig, devices } from "@playwright/test";

// エディタ (editor/ui.html) の実ブラウザ E2E。vitest(node) とは別ランナーで併存し、
// *.e2e.ts のみを対象にする (vitest は *.test.ts を担当)。
export default defineConfig({
  testDir: "test",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5179",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // ui.html と lib/leader_geom.cjs を同一オリジンで配信する静的サーバ。
  webServer: {
    command: "node test/editor_server.mjs",
    url: "http://127.0.0.1:5179/ui.html",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
