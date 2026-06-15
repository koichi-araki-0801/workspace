import { config } from '../config.js';

/**
 * Inline-config fields shared by every `@vivliostyle/cli` invocation
 * (build inline / build project / preview). This is the single place that
 * pins the browser and silences logging, so the three code paths stay in
 * lockstep (vivliostyle usage is consolidated under `vivliostyle/`).
 */
export interface SharedInlineConfig {
  /** System browser pinned for offline runs; omitted to use the default. */
  executableBrowser?: string;
  logLevel: 'silent';
}

/**
 * Build the options common to build() and preview().
 *
 * Pins the configured browser (auto-detected system Edge offline) so runs
 * never try to download Chromium. puppeteer cannot resolve Windows
 * backslash-separated `executableBrowser` paths, so the path is normalized to
 * forward slashes (moved here from the former `pdf/vivliostyle.ts`).
 */
export function sharedInlineConfig(): SharedInlineConfig {
  const executableBrowser = config.pdf.executableBrowser?.replace(/\\/g, '/');
  return {
    ...(executableBrowser ? { executableBrowser } : {}),
    logLevel: 'silent',
  };
}
