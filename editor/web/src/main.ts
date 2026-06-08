import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { localRepositories, REPOS_KEY } from './api/repositories';
import { initTheme } from './lib/theme';
import { router } from './router';
import './assets/index.css';

initTheme();

const app = createApp(App);
app.provide(REPOS_KEY, localRepositories);
app.use(createPinia());
app.use(router);
app.mount('#app');
