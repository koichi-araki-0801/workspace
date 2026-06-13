import { toAppError } from '@editor/shared';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { seedCompareFixtures } from './api/local/seed';
import { localRepositories, REPOS_KEY, restRepositories } from './api/repositories';
import { toastError } from './components/ui/toast';
import { logError } from './lib/appError';
import { initTheme } from './lib/theme';
import { router } from './router';
import './assets/index.css';

/**
 * Last-resort handler for failures that never reach `useAsyncResult().run()`:
 * Vue render/lifecycle errors, unhandled promise rejections, and raw global
 * `error` events (e.g. GrapesJS callbacks, dynamic imports). Without this such
 * failures would only hit the console and leave the user with no feedback.
 * A short dedupe avoids spamming identical toasts when an error fires in a loop.
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

// Data source: REST (phase 2 SQL Server backend) when VITE_API_MODE=rest,
// otherwise the local fixtures + localStorage set (phase 1, default).
const useRest = import.meta.env.VITE_API_MODE === 'rest';
const repositories = useRest ? restRepositories : localRepositories;

initTheme();
// Compare-screen demo fixtures only make sense for the local store.
if (!useRest) seedCompareFixtures();

const app = createApp(App);
app.config.errorHandler = (err) => reportGlobalError(err);
window.addEventListener('unhandledrejection', (ev) => reportGlobalError(ev.reason));
window.addEventListener('error', (ev) => reportGlobalError(ev.error ?? ev.message));
app.provide(REPOS_KEY, repositories);
app.use(createPinia());
app.use(router);
app.mount('#app');
