/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// coverage はルート vitest.config.ts に一本化(集約・閾値 85%)。ここは environment/globals と
// Playwright の *.e2e.ts を vitest 対象外にする exclude のみを担う。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Playwright の *.e2e.ts は vitest 対象外 (test:e2e で別ランナーが担当)。
    exclude: ["**/node_modules/**", "**/*.e2e.ts"],
  },
});
