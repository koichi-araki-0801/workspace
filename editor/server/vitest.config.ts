/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so tests don't need a build.
      // alias は前方一致で効くため、サブパス(/schemas)のエントリを '@editor/shared' より
      // 先に置く。順序を崩すと `/schemas` が `.../src/index.ts/schemas` に化けて壊れる。
      '@editor/shared/schemas': fileURLToPath(new URL('../shared/src/schemas.ts', import.meta.url)),
      '@editor/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  // coverage はルート vitest.config.ts に一本化(集約・閾値 85%)。ここは environment/globals と
  // 「テスト時 @editor/shared を source 解決」する alias(上記)のみを担う。
  test: {
    // ルート vitest.config.ts の `projects` 集約で `--project server` 選別を効かせるための名前。
    name: 'server',
    environment: 'node',
    globals: true,
  },
});
