/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      // Scope coverage (and its thresholds) to the modules under test. Widen this
      // list as new tests are added so the gate grows with the suite. Large layout
      // engines (layout.ts / label_placement.ts / svg_export/*) are exercised by
      // the verify_* scripts and are intentionally out of the unit-coverage gate
      // for now.
      include: [
        "src/svg_geom.ts",
        "src/config.ts",
        "src/glyph_advance.ts",
        "src/data.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
