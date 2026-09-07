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
    // Vite 既定の 5173 は他ツールと被りやすいため、衝突しにくい 24681 に固定
    // (server 側 :24680 と対で予約。選定理由は editor/README.md の「LAN 公開」節)。
    port: 24681,
    proxy: {
      '/api': {
        // rest e2e(playwright project `rest`)は 24690 の別サーバを使うため、proxy 先を
        // `API_PROXY_TARGET` で上書き可能にする。`VITE_` 接頭辞を付けないのは、付けると
        // Vite がクライアントバンドルへ露出させる値になり、この内部アドレスをブラウザ側
        // JS に埋め込むことになるため(`import.meta.env` へは載せない)。
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:24680',
        changeOrigin: true,
      },
    },
  },
});
