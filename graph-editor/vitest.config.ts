/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Playwright の *.e2e.ts は vitest 対象外 (test:e2e で別ランナーが担当)。
    exclude: ["**/node_modules/**", "**/*.e2e.ts"],
    coverage: {
      provider: "v8",
      // ui.html と共有する純粋関数のみを対象に 80% を担保する。
      include: ["lib/leader_geom.cjs"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
