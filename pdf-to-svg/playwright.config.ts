import { defineConfig, devices } from "@playwright/test";

// PdfToSvg フロント (resources/web) の実ブラウザ E2E。vitest(node) とは別ランナーで
// 併存し、*.e2e.ts のみを対象にする (vitest は *.test.js を担当)。バックエンドは
// test/e2e_server.py が実 Python サーバ (RPC/upload 込み) を固定ポートで起動する。
export default defineConfig({
  testDir: "test",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false, // サーバ側セッション (docs/undo) を共有するため直列実行
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5180",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "python test/e2e_server.py",
    url: "http://127.0.0.1:5180/",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
