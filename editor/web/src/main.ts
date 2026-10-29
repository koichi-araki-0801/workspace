// =============================================================================
// main.ts — Vue アプリのエントリポイント(初期化・global error handler の配線・mount)
// =============================================================================
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { REPOS_KEY, restRepositories } from './api/repositories';
import { handleWindowError, reportGlobalError } from './lib/globalErrors';
import { setUnauthorizedHandler } from './lib/sessionExpiry';
import { initTheme } from './lib/theme';
import { router } from './router';
import { useAuthStore } from './stores/auth';
// Self-hosted な webfont(Google Fonts CDN を使わない)。@fontsource は @font-face
// + woff2 を同梱するため, Vite が same-origin かつオフライン可能な配信用に bundle する。
import '@fontsource-variable/noto-sans-jp/index.css';
import '@fontsource-variable/noto-serif-jp/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
// GrapesJS の layer/toolbar アイコン用 Font Awesome glyph。ローカル bundle により
// エディタが cdnjs から FA を取得しなくなる(GrapesJS の `cssIcons` は `useGrapes.ts`
// で空にし, リモート `<link>` 注入を止めている)。`editor/OFFLINE.md` を参照。
import 'font-awesome/css/font-awesome.css';
import './assets/index.css';

initTheme();
const app = createApp(App);
app.config.errorHandler = (err) => reportGlobalError(err);
window.addEventListener('unhandledrejection', (ev) => reportGlobalError(ev.reason));
window.addEventListener('error', handleWindowError);
app.provide(REPOS_KEY, restRepositories);
app.use(createPinia());
app.use(router);

// セッション切れ(401)の受け口。
// 画面が認証済みのまま静かに失敗し続けるのを避け、auth state を落としてログイン画面へ
// 退避する。着地後に戻れるよう、離脱時のパスを `redirect` に載せる。
setUnauthorizedHandler(() => {
  useAuthStore().reset();
  const current = router.currentRoute.value;
  if (current.name === 'login') return;
  void router.replace({ name: 'login', query: { redirect: current.fullPath } });
});

app.mount('#app');
