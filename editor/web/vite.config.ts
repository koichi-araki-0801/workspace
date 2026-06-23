/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// dev 起動ごとに変わる epoch。`vite dev` の再起動で再評価され新値になる。`transformIndexHtml`
// で index.html の `%APP_EPOCH%` を置換し、クライアントが再起動を検知して再ログインを強制する。
// build 時は置換しない(`apply: 'serve'`)ので、本番は Express が配信時に注入する(app.ts)。
const APP_EPOCH = String(Date.now());

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: 'app-epoch',
      apply: 'serve',
      transformIndexHtml: (html: string) => html.replaceAll('%APP_EPOCH%', APP_EPOCH),
    },
  ],
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
        'src/features/editor/pageView.ts',
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
