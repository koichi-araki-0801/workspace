/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

// coverage はルート vitest.config.ts に一本化(集約・閾値 85%)。ここは environment/globals のみ。
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
});
