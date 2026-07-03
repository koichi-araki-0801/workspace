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
  // HTML 重処理は module worker(`workers/index.ts` の `new Worker(..., {type:'module'})`)で動かす。
  // 既定の `iife` だと worker が共有チャンクを分割 import できず、オフライン/本番の静的配信下で
  // worker チャンクの解決に失敗してプレビューが白紙になり得る。出力形式を `es` に固定して
  // module worker と分割チャンクの読み込みを揃える。
  worker: {
    format: 'es',
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
  // coverage はルート vitest.config.ts に一本化(全プロジェクト集約・閾値 85%)。ここは
  // web プロジェクトの environment/globals のみを担う。
  test: {
    // ルート vitest.config.ts の `projects` 集約で `--project web` 選別を効かせるための名前。
    name: 'web',
    environment: 'jsdom',
    globals: true,
  },
});
