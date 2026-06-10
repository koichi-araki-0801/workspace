/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@editor/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      // Scope coverage (and its thresholds) to the modules under test. Widen this
      // list as new tests are added so the gate grows with the suite.
      include: [
        'src/lib/jinjaMask.ts',
        'src/lib/appError.ts',
        'src/lib/useAsyncResult.ts',
        'src/lib/format.ts',
        'src/lib/labels.ts',
        'src/features/templates/viewmodels/templateVm.ts',
        'src/features/templates/services/templateCreationService.ts',
        'src/features/editor/services/templateEditorService.ts',
        'src/features/preview/services/templatePreviewService.ts',
        'src/features/admin/viewmodels/userVm.ts',
        'src/lib/templateDoc.ts',
        'src/lib/usePagedList.ts',
        'src/lib/nunjucksRender.ts',
        'src/lib/useCascadingSelect.ts',
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
