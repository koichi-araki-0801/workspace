// =============================================================================
// main.ts — Vue アプリのエントリポイント(初期化・global error handler・mount)
// =============================================================================
import { toAppError } from '@editor/shared';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { seedCompareFixtures } from './api/local/seed';
import { migrateStore } from './api/local/store';
import { localRepositories, REPOS_KEY, restRepositories } from './api/repositories';
import { toastError } from './components/ui/toast';
import { logError } from './lib/appError';
import { initTheme } from './lib/theme';
import { router } from './router';
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

/**
 * `useAsyncResult().run()` に届かない失敗の最終 handler: Vue の render/lifecycle
 * エラー, unhandled promise rejection, 生の global `error` イベント(例 GrapesJS
 * コールバック, dynamic import)。これが無いとそうした失敗は console に出るだけで,
 * ユーザーには何のフィードバックも残らない。短い dedupe で, ループ内でエラーが
 * 連発しても同一 toast の連投を避ける。
 */
let lastMessage = '';
function reportGlobalError(e: unknown): void {
  const ae = toAppError(e);
  logError(ae);
  if (ae.message !== lastMessage) {
    lastMessage = ae.message;
    toastError(ae.message);
  }
}

/**
 * `ResizeObserver loop completed with undelivered notifications`(および limit exceeded)は、
 * 監視コールバック内の再レイアウトで 1 フレームに配信しきれなかった通知がある、という
 * **良性の警告**(次フレームで配信され実害なし)。ブラウザはこれを global `error` として
 * 上げるため、握りつぶさないと比較結果(`iframe` リサイズ)のたび「予期しないエラー」
 * toast が出てしまう。このメッセージだけは無視する。
 */
function isBenignResizeObserverError(message: unknown): boolean {
  return typeof message === 'string' && message.includes('ResizeObserver loop');
}

// データソース: `VITE_API_MODE=rest` なら REST(フェーズ2 SQL Server backend),
// それ以外は local fixtures + localStorage 一式(フェーズ1, 既定)。
const useRest = import.meta.env.VITE_API_MODE === 'rest';
const repositories = useRest ? restRepositories : localRepositories;

initTheme();
// local store のみ: schema bump 時に古い fixture 由来の working-state を clear し,
// 次に現行 template id で compare 画面のデモデータを seed する。
if (!useRest) {
  migrateStore();
  seedCompareFixtures();
}

const app = createApp(App);
app.config.errorHandler = (err) => reportGlobalError(err);
window.addEventListener('unhandledrejection', (ev) => reportGlobalError(ev.reason));
window.addEventListener('error', (ev) => {
  // ResizeObserver の良性警告は toast を出さない(下記 helper 参照)。
  if (isBenignResizeObserverError(ev.message)) return;
  reportGlobalError(ev.error ?? ev.message);
});
app.provide(REPOS_KEY, repositories);
app.use(createPinia());
app.use(router);
app.mount('#app');
