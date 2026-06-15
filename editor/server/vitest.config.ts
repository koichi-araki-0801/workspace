/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so tests don't need a build.
      '@editor/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      // Scope coverage (and its thresholds) to the modules under test. Widen this
      // list as new tests are added so the gate grows with the suite.
      include: [
        'src/templates/fileIndex.ts',
        'src/generate/pyTemplate.ts',
        'src/middleware/*.ts',
        // vivliostyle pure layers (the cli-backed build.ts / previewServer.ts /
        // previewProxy.ts need a real browser+socket and stay out of the gate).
        'src/vivliostyle/options.ts',
        'src/vivliostyle/projectInput.ts',
        'src/vivliostyle/previewManager.ts',
      ],
      // `auth.ts` はフェーズ2 (DBセッション/SQL Server依存) で未テスト・未デプロイのため、
      // テストが入るまでゲート対象から除外する (上記 include の方針「テスト対象のみゲート」準拠)。
      exclude: ['src/middleware/auth.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
