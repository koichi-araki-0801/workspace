// =============================================================================
// theme.ts — light/dark テーマの解決・適用・永続化
// =============================================================================
import { ref } from 'vue';

type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'ret:theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function stored(): ThemeMode | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** no-flash inline script が既に `<html>` へ適用済みのテーマ(あれば)。 */
function attribute(): ThemeMode | null {
  const v = document.documentElement.getAttribute('data-theme');
  return v === 'light' || v === 'dark' ? v : null;
}

/**
 * 現在のテーマ。`index.html` の no-flash script が本モジュール読み込み前にテーマを
 * 解決・適用するため, まずその attribute を採用する。次に stored 設定, 最後に OS
 * 設定へフォールバックする。
 */
export const theme = ref<ThemeMode>(
  attribute() ?? stored() ?? (systemPrefersDark() ? 'dark' : 'light'),
);

function apply(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
}

/** `<html data-theme>` を解決済みテーマに合わせる。アプリ起動時に一度呼ぶこと。 */
export function initTheme(): void {
  apply(theme.value);
}

function setTheme(mode: ThemeMode): void {
  theme.value = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  apply(mode);
}

export function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}
