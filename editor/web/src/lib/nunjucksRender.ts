// =============================================================================
// nunjucksRender.ts — ブラウザでの Jinja2 テンプレートのプレビュー描画
// =============================================================================
import type { SampleData } from '@editor/shared';
import nunjucks from 'nunjucks';
import { formatCss, formatHtml } from './formatOutput';
import {
  appendPreviewStyle,
  sanitizePreviewRoot,
  serializePreviewRoot,
  stripExternalRefs,
} from './sanitizeHtml';

/**
 * 生 Jinja2 テンプレートを sample data でブラウザ上に Nunjucks (Jinja2 互換)で
 * 描画する。プレビュー専用 — 本番レンダリングではない。
 */
const env = new nunjucks.Environment(undefined, {
  autoescape: true,
  throwOnUndefined: false,
});

export interface RenderResult {
  html: string;
  error: string | null;
}

export function renderJinja(template: string, data: SampleData): RenderResult {
  try {
    return { html: env.renderString(template, data as object), error: null };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 描画済み HTML(nunjucks 適用後)を自己完結なプレビュー文書へ組み立てる: サニタイズし,
 * CSS を inline 化する。重い `renderJinja` を含まないので, Worker から受け取った描画済み
 * HTML をメインで組み立てる用途に使える(描画は Worker, 組み立てはメイン、という分割の
 * ためのシーム)。
 *
 * 加工はすべて**パース済み DOM の上**で行い、文字列に戻すのは最後の 1 回だけ
 * (`sanitizeHtml.ts` 冒頭の不変則)。以前はサニタイズ済み文字列へ `<link…>` 除去と
 * `</head>` アンカー挿入を正規表現で当てていたが、属性値に置いた `<link rel=stylesheet>` や
 * `</head>` の字面にマッチして要素のタグ終端まで食い、直後のテキストが `on*` 属性として
 * 復活した。**ここへアンカー探索や部分除去を戻してはならない。**
 *
 * `opts.extraCss` は本文 CSS の後ろへもう 1 枚 `<style>` を足す(トンボ等、アプリ定数の CSS
 * 用)。後勝ちにするため本文 CSS より後に挿す。
 */
export function assemblePreviewDocument(
  renderedHtml: string,
  css: string,
  opts?: { extraCss?: string },
): string {
  // 整形はサニタイズの**前**。最終バイトを決めるのは HTML 仕様のパーサ(DOMPurify 内蔵)で
  // なければならず、js-beautify を後段に置くと保証がそこで途切れる。Jinja 解決済みの純
  // HTML なので整形は安全 — プレビュー/PDF 入力を読める形にする。
  const root = sanitizePreviewRoot(formatHtml(renderedHtml));
  // 外部 stylesheet `<link>`(例: `<link rel="stylesheet" href="css/110024.css">`)は
  // サニタイザの許可リストが既に落としている。CSS は直後に inline 化するため不要で, 残ると
  // viewer が Blob 相対 URL で解決して 404 になり `@vivliostyle/core` のフェッチャが
  // ページ分割を中断する。ここは構造の上での二重化(版差と非サニタイズ経路の保険)。
  stripExternalRefs(root);
  // CSS は DOMPurify を通らないため `</style>` 脱出は `appendPreviewStyle` の中で潰す。
  appendPreviewStyle(root, formatCss(css), { 'data-preview-css': '' });
  if (opts?.extraCss) appendPreviewStyle(root, opts.extraCss, { 'data-extra-css': '' });
  return serializePreviewRoot(root);
}

/**
 * 自己完結なプレビュー文書を組み立てる: テンプレートを sample data で描画し,
 * ファンドごとの CSS を inline 化する(外部 `<link>` は viewer では 404 になるため)。
 */
export function buildPreviewDocument(rawHtml: string, css: string, data: SampleData): RenderResult {
  const rendered = renderJinja(rawHtml, data);
  if (rendered.error) return rendered;
  return { html: assemblePreviewDocument(rendered.html, css), error: null };
}
