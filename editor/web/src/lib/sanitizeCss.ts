// =============================================================================
// sanitizeCss.ts — `<style>` へ埋め込む CSS のコンテキスト脱出を止める
// =============================================================================
// 外部参照の検出(`findExternalRefsInCss`)は `@editor/shared` へ移した。**関門はサーバの
// build 入口**(`server/src/security/externalRefs.ts`)にあり、ここからの再エクスポートは
// 画面が早期フィードバックを出すための同じ関数への窓にすぎない。ブラウザ側の検査を
// 唯一の関門にしないこと — 公開 API `POST /api/build` は UI を経由しない。
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

/**
 * `sanitizeStyleContent` を適用した `<style>` 要素を組み立てる。属性は呼び出し側指定。
 *
 * ⚠ これは*包む*(前後に定数を連結する)専用で、素材が 100% 自分の管理下にある場合にだけ
 * 使ってよい。DOM が使える経路では `sanitizeHtml.ts` の `appendPreviewStyle` を使うこと。
 * 現在の唯一の利用者は `htmlBlockDiff.buildDiffDoc`(srcdoc 文字列の組み立て)。
 */
export function styleTag(css: string, attrs = ''): string {
  return `<style${attrs ? ` ${attrs}` : ''}>${sanitizeStyleContent(css)}</style>`;
}

// ── CSS の外部参照検出 ──────────────────────────────────
// 実体は `@editor/shared` の `security/cssExternalRefs.ts`。サーバの build 入口と web が
// **同一の関数**を使うことが要件で、片方だけを直す退行を構造で防ぐ。
export { findExternalRefsInCss, isSelfContainedUrl } from '@editor/shared';
