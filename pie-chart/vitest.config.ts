/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// coverage はルート vitest.config.ts に一本化(集約・閾値 85%)。ここは environment/globals のみ。
export default defineConfig({
  test: {
    // ルート vitest.config.ts の `projects` 集約で `--project pie-chart` 選別を効かせるための名前。
    name: 'pie-chart',
    environment: 'node',
    globals: true,
  },
});
