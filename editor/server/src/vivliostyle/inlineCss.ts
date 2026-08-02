// =============================================================================
// inlineCss.ts — CSS 文字列を HTML ドキュメントへインライン展開する純粋関数
// =============================================================================
// 元は `build.ts` の私有関数。結合 build(`mergeInput.ts`)が文書実体化で同じ展開を
// 必要とするため独立モジュールへ切り出した(挙動は移動前とバイト同一に保つ)。

/** CSS 文字列を HTML ドキュメントへインライン展開する(head / body / 完全ラッパ)。 */
export function inlineCss(html: string, css: string): string {
  // CSS は inline 化するため, テンプレ由来の外部 stylesheet `<link>` は除去する(head/body 分岐の前)。
  // PDF(headless browser)では 404 で無視されるだけだが, ブラウザ内 `@vivliostyle/core` を使う
  // プレビュー経路(`buildPreviewDocument`)と挙動を揃え, 不要な失敗フェッチも無くす。
  const cleaned = html.replace(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, '');
  if (!css) return cleaned;
  const styleTag = `<style>\n${css}\n</style>`;
  if (/<\/head>/i.test(cleaned)) return cleaned.replace(/<\/head>/i, `${styleTag}</head>`);
  if (/<body[^>]*>/i.test(cleaned)) return cleaned.replace(/<body([^>]*)>/i, `<body$1>${styleTag}`);
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${cleaned}</body></html>`;
}
