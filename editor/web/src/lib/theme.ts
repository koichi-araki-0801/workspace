import { ref } from 'vue';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'ret:theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function stored(): ThemeMode | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** The theme the no-flash inline script already applied to <html>, if any. */
function attribute(): ThemeMode | null {
  const v = document.documentElement.getAttribute('data-theme');
  return v === 'light' || v === 'dark' ? v : null;
}

/**
 * Current theme. The no-flash script in index.html resolves and applies the
 * theme before this module loads, so we adopt that attribute first; fall back
 * to stored preference, then the OS setting.
 */
export const theme = ref<ThemeMode>(
  attribute() ?? stored() ?? (systemPrefersDark() ? 'dark' : 'light'),
);

function apply(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
}

/** Ensure <html data-theme> matches the resolved theme. Call once at app start. */
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
