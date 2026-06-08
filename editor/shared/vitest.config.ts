/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      // Scope coverage (and its thresholds) to the modules under test. Widen this
      // list as new tests are added so the gate grows with the suite.
      include: [
        'src/index.ts',
        'src/result.ts',
        'src/errors.ts',
        'src/domain/template.ts',
        'src/domain/user.ts',
        'src/domain/history.ts',
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
