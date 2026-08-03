// =============================================================================
// sanitizeHtml.ts — 他ユーザ由来 HTML の能動コンテンツ除去(プレビュー / 編集 canvas)
// =============================================================================
// テンプレ HTML は「別のユーザが書いたもの」を開く前提で、しかも 2 つの経路でアプリと同一
// オリジンへ入る。経路ごとに手段が違うため、本ファイルは 2 本の関数を持つ:
//   1. プレビュー / PDF — `@vivliostyle/core` が本体 document に直接描画するので、文字列を
//      DOMPurify に通す(`sanitizePreviewHtml`)。
//   2. 編集 canvas — GrapesJS のパーサが作った node ツリーを、component 化される前に
//      刈り取る(`pruneCanvasActiveContent`)。文字列を再直列化しないのが要点。
import DOMPurify from 'dompurify';

// ── 1. プレビュー / PDF 経路 ──

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

// ── 2. 編集 canvas(GrapesJS パーサ)経路 ──

/**
 * GrapesJS の HTML パーサが返す node の最小構造。`grapesjs` の `ParsedNode` と構造的に
 * 互換で、lib 層が GrapesJS へ型依存しないよう自前で持つ。
 */
export interface ParsedHtmlNode {
  tagName?: string;
  attributes?: Record<string, string>;
  childNodes?: ParsedHtmlNode[];
}

/**
 * canvas へ入れてはならない要素。いずれも自前の browsing context を作る種類で、中身が
 * アプリのオリジンでスクリプトを走らせられる。GrapesJS 0.23 のパーサ既定
 * (`allowScripts:false` / `allowUnsafeAttr:false`)が落とすのは `<script>` と `on*` と
 * `javascript:` 始まりの属性値だけで、これらの要素は素通りする。canvas の iframe は
 * `about:blank` でアプリのオリジンを継承し、GrapesJS が親から中の DOM を直接操作するため
 * `sandbox` も付けられない。よって入口で落とすのが唯一の防壁になる。
 */
const FORBIDDEN_TAGS = new Set(['iframe', 'object', 'embed', 'frame', 'frameset']);

/** スクリプト実行しうる URL を取りうる属性。ここに限定して本文中の文字列の誤検出を避ける。 */
const URL_ATTRS = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
]);

/** `javascript:` / `vbscript:` を、先頭空白・制御文字・大文字混じりの回避ごと判定する。 */
function isScriptUrl(value: string): boolean {
  // URL パーサは値中の空白・制御文字(tab/改行/NUL 等)をスキームの判定前に捨てるため、
  // 同じ正規化をしてから判定する。GrapesJS 側の判定は素の `startsWith('javascript:')` で、
  // ` JavaScript:` のような変形を取りこぼす。`c > ' '` は空白と C0 制御文字をまとめて
  // 落とす比較で、正規表現に制御文字を書かずに済む(biome の禁止ルール回避)。
  const normalized = [...value]
    .filter((c) => c > ' ')
    .join('')
    .toLowerCase();
  return normalized.startsWith('javascript:') || normalized.startsWith('vbscript:');
}

/**
 * GrapesJS のパース済みツリーから能動コンテンツを取り除く(その場で書き換える)。
 * `parse:html:root` フックから呼び、component 化される前のツリーを刈る。
 *
 * 落とすのは (a) `FORBIDDEN_TAGS` の要素まるごと、(b) `on*` ハンドラ属性、
 * (c) `URL_ATTRS` のうち `javascript:`/`vbscript:` の値。(b) は GrapesJS 既定と重複するが、
 * 既定値の変更や版差で無防備になるのを防ぐため自前でも落とす。
 *
 * 文字列へ戻さないのが重要: 編集 canvas の HTML は Jinja chip(`data-jinja` 等)と
 * `{% for %}` を吸収した属性を持ち、DOM 再直列化を挟むと table の foster parenting や
 * 実体参照の再エンコードで差分が出る(`jinjaMask.ts` が避けている経路)。
 */
export function pruneCanvasActiveContent(root: ParsedHtmlNode): void {
  const attrs = root.attributes;
  if (attrs) {
    for (const name of Object.keys(attrs)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || (URL_ATTRS.has(lower) && isScriptUrl(attrs[name]))) {
        delete attrs[name];
      }
    }
  }
  const kids = root.childNodes;
  if (!kids) return;
  const kept = kids.filter((kid) => !FORBIDDEN_TAGS.has((kid.tagName ?? '').toLowerCase()));
  if (kept.length !== kids.length) root.childNodes = kept;
  for (const kid of kept) pruneCanvasActiveContent(kid);
}
