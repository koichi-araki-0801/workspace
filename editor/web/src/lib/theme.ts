import { ref } from 'vue';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function stored(): ThemeMode | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** Current theme; defaults to stored preference, else the OS setting. */
export const theme = ref<ThemeMode>(stored() ?? (systemPrefersDark() ? 'dark' : 'light'));

function apply(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
}

/** Apply the resolved theme to <html>. Call once at app start. */
export function initTheme(): void {
  apply(theme.value);
}

export function setTheme(mode: ThemeMode): void {
  theme.value = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  apply(mode);
}

export function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}
