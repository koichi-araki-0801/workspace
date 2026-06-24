// =============================================================================
// sanitizeHtml.ts — プレビュー/PDF へ渡す前のテンプレ HTML サニタイズ
// =============================================================================
// プレビューは `@vivliostyle/core` がテンプレ HTML を **本体 document に直接描画**するため
// (`PreviewPanel.vue` 参照)、テンプレ本文の `<script>`・`on*` ハンドラ・`javascript:` URL が
// アプリ本体オリジンで実行される保存型 XSS になりうる。描画直前に DOMPurify で能動コンテンツを
// 除去する。レポートの体裁(`<style>` / inline `style` / class / data-* / 表・幾何)は保持する。
import DOMPurify from 'dompurify';

/**
 * テンプレ HTML(レンダリング済み)をサニタイズする。`<script>`・イベントハンドラ属性・
 * `javascript:`/`data:` 等の危険な URL を除去しつつ、レポートの構造と CSS は保つ。
 *
 * `WHOLE_DOCUMENT` で `<html>/<head>/<body>` を保持する(テンプレは完全文書)。DOMPurify は
 * doctype を出力に含めないため、標準モード(vivliostyle のレイアウトが依存)を保つよう
 * `<!doctype html>` を前置する。`<style>`/inline `style` は明示的に許可する。
 */
export function sanitizePreviewHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style'],
  });
  // DOMPurify は doctype を落とすため、標準モード維持のため補う(quirks モードで vivliostyle の
  // ページ分割/レイアウトが崩れるのを防ぐ)。
  return /<html[\s>]/i.test(clean) ? `<!doctype html>\n${clean}` : clean;
}
