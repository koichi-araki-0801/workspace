import { toAppError } from '@editor/shared';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { seedCompareFixtures } from './api/local/seed';
import { localRepositories, REPOS_KEY } from './api/repositories';
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

initTheme();
seedCompareFixtures();

const app = createApp(App);
app.config.errorHandler = (err) => reportGlobalError(err);
window.addEventListener('unhandledrejection', (ev) => reportGlobalError(ev.reason));
window.addEventListener('error', (ev) => reportGlobalError(ev.error ?? ev.message));
app.provide(REPOS_KEY, localRepositories);
app.use(createPinia());
app.use(router);
app.mount('#app');
