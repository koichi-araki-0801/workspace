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
        'src/features/editor/geom.ts',
        'src/features/editor/useSnapshotHistory.ts',
        'src/features/editor/usePartEditHistory.ts',
        'src/features/editor/useAutosave.ts',
        'src/features/compare/htmlBlockDiff.ts',
        'src/features/compare/services/compareService.ts',
        'src/api/local/authRepo.ts',
        'src/api/local/templateRepo.ts',
        'src/api/local/userRepo.ts',
        'src/api/local/historyRepo.ts',
        'src/api/local/partRepo.ts',
      ],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
