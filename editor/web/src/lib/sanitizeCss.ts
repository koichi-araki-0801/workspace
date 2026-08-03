// =============================================================================
// sanitizeCss.ts — `<style>` へ埋め込む CSS のコンテキスト脱出を止める
// =============================================================================
// HTML パーサにとって `<style>` の中身は raw text で、終端は「最初に現れる `</style`」1 つだけ。
// CSS の文字列リテラルの内側かどうかは一切見ないため、テンプレのファンド CSS に
// `content:"</style><script>…"` と書くだけで style 要素を閉じ、スクリプトを注入できる。
// HTML 側は DOMPurify(`sanitizeHtml.ts`)が見るが、CSS 文字列はそこを通らないため、
// `<style>` へ差し込む直前にここで潰す。
//
// 置換は「`</` の `/` を CSS のエスケープ `\/` にする」だけに留める。CSS 文字列の中では
// `\/` は `/` と同義なので見た目・意味とも変わらず、HTML パーサからは `</style` に
// 一致しなくなる(= 要素が閉じない)。正当な CSS がこの並びを必要とすることはない。
const STYLE_CLOSE_RE = /<\/(?=style)/gi;

/** `<style>` の中身として安全な形にする(要素を閉じられなくする)。 */
export function sanitizeStyleContent(css: string): string {
  return css.replace(STYLE_CLOSE_RE, '<\\/');
}

/** `sanitizeStyleContent` を適用した `<style>` 要素を組み立てる。属性は呼び出し側指定。 */
export function styleTag(css: string, attrs = ''): string {
  return `<style${attrs ? ` ${attrs}` : ''}>${sanitizeStyleContent(css)}</style>`;
}
