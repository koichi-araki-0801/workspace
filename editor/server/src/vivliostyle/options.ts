// =============================================================================
// options.ts — `@vivliostyle/cli` 呼び出し共通の inline-config を組み立てる
// =============================================================================
import { config } from '../config.js';

/**
 * すべての `@vivliostyle/cli` 呼び出し(build inline / build project / preview)で共有する
 * inline-config フィールド。ブラウザの固定とログ抑制を一元化する唯一の場所で、3 つの
 * コード経路を歩調を揃えて保つ(vivliostyle の利用は `vivliostyle/` 配下に集約)。
 */
interface SharedInlineConfig {
  /** オフライン実行用に固定するシステムブラウザ。省略時は既定を使う。 */
  executableBrowser?: string;
  logLevel: 'silent';
}

/**
 * `build()` と `preview()` に共通のオプションを組み立てる。
 *
 * 設定済みブラウザ(自動検出したシステム Edge / オフライン)を固定し、実行時に Chromium を
 * ダウンロードしようとしないようにする。puppeteer は Windows のバックスラッシュ区切りの
 * `executableBrowser` パスを解決できないため、スラッシュへ正規化する
 * (旧 `pdf/vivliostyle.ts` からここへ移設)。
 */
export function sharedInlineConfig(): SharedInlineConfig {
  const executableBrowser = config.pdf.executableBrowser?.replace(/\\/g, '/');
  return {
    ...(executableBrowser ? { executableBrowser } : {}),
    logLevel: 'silent',
  };
}
