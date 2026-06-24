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
  // coverage はルート vitest.config.ts に一本化(集約・閾値 85%)。ここは environment/globals と
  // 「テスト時 @editor/shared を source 解決」する alias(上記)のみを担う。
  test: {
    environment: 'node',
    globals: true,
  },
});
