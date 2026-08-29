// =============================================================================
// htmlParser.ts — HTML 文字列を Document へパースする実装の抽象(DOM 実装の注入用)
// =============================================================================
// メイン/テストは browser・jsdom の `DOMParser` を、Worker は linkedom の `parseHTML`
// を使えるよう、パーサを関数として注入可能にする。これにより DOM 依存の diff/mask
// ロジックを 1 実装のままメイン・Worker 双方で共有でき、コードの二重管理を避けられる。
export type HtmlParser = (html: string) => Document;

/** 既定パーサ: browser・jsdom の `DOMParser`(メインスレッド / vitest jsdom 用)。 */
export const defaultHtmlParser: HtmlParser = (html) =>
  new DOMParser().parseFromString(html, 'text/html');
