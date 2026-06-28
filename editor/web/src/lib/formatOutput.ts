// =============================================================================
// formatOutput.ts — 出力物 HTML/CSS の整形(pretty-print)
// =============================================================================
// 役割:
//   editor が保存・出力する HTML/CSS は GrapesJS の `getHtml()`/`getCss()` 由来で
//   minified になっており可読性が低い。確定版テンプレ(`data/templates`)とファンド CSS
//   (`data/css`)は git 管理されるため、整形して diff/レビューを読めるようにする。
//
// 設計:
//   js-beautify は html/css/js 整形を 1 パッケージに同梱し、ブラウザ/Worker/Node の
//   いずれでも動く pure JS。整形は「文字列 -> 文字列」の DOM 非依存処理なので、linkedom
//   Worker でもメインでも同一関数で使える。タグを再配置せずインデントのみ行う保守的な
//   挙動のため、`jinjaMask.ts` がマスクした placeholder 入り HTML でも構造を壊さない。
//
// 注意:
//   HTML 整形は Jinja を理解しない。Jinja を含む確定版テンプレは `jinjaMask.ts` の
//   `toTemplate` がトークンを placeholder に退避した後(= valid HTML)で本関数を呼ぶこと。
//   生 Jinja HTML へ直接かけると `{% for %}` 等の構文を壊す。CSS は静的前提で安全。
import { css as beautifyCss, html as beautifyHtml } from 'js-beautify';

// ── 1. 共有オプション ──────────────────────────────────────────────────────
// `indent_size: 2` は fixtures/biome の 2 スペースに揃える。`wrap_line_length: 0` は
// 折り返し無効 — 長い行を割らないことで属性の多い要素でも差分ノイズを抑える。
const HTML_OPTS: Parameters<typeof beautifyHtml>[1] = {
  indent_size: 2,
  wrap_line_length: 0,
  preserve_newlines: true,
  // 空白が意味を持つ要素は中身を整形しない(改行/インデント挿入で表示が変わるのを防ぐ)。
  content_unformatted: ['pre', 'textarea', 'script', 'style'],
};

const CSS_OPTS: Parameters<typeof beautifyCss>[1] = {
  indent_size: 2,
  selector_separator_newline: true,
};

// ── 2. 公開 API ────────────────────────────────────────────────────────────
/** 出力 HTML を整形する。Jinja を含む場合は placeholder マスク後に呼ぶこと(冒頭注意)。 */
export function formatHtml(html: string): string {
  return beautifyHtml(html, HTML_OPTS);
}

/** 出力 CSS を整形する。整形は冪等なので整形済み CSS を再度通しても安全。 */
export function formatCss(css: string): string {
  return beautifyCss(css, CSS_OPTS);
}
