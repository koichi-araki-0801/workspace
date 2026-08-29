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
 *
 * `autoescape` / `throwOnUndefined` の 2 設定は、隔離側(`server/src/render/renderHost.ts` の
 * ブートスクリプト)が**同じ値で**Environment を作る根拠でもある。隔離へ移して描画結果が
 * 変わらないことがここと向こうで揃っていることの意味なので、片方だけ変えない。
 */
const env = new nunjucks.Environment(undefined, {
  autoescape: true,
  throwOnUndefined: false,
});

export interface RenderResult {
  html: string;
  error: string | null;
}

/**
 * ⚠ **アプリオリジンからこの関数を呼ばないこと。** nunjucks はサンドボックスではなく
 * コンパイラで、`{{ range.constructor("…")() }}` は `new Function` へ到達する。他人が書いた
 * テンプレをアプリのページで通すと、そのテンプレの字面が閲覧者のセッションでの JS 実行に
 * なる。呼び出し口は `lib/renderHostClient.ts` の `renderJinjaIsolated` 一本で、
 * 実際のコンパイルは opaque オリジンの iframe が行う。この定義が残っているのは Environment
 * 設定の出所を 1 箇所に保つため(禁止は `test/ssti.guard.test.ts` が機械検証する)。
 */
export function renderJinja(template: string, data: SampleData): RenderResult {
  try {
    return { html: env.renderString(template, data as object), error: null };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 描画済み HTML(nunjucks 適用後)を自己完結なプレビュー文書へ組み立てる: サニタイズし,
 * CSS を inline 化する。**コンパイルを含まない**ので、隔離 iframe が返した描画済み HTML を
 * アプリオリジンで組み立てる用途に使える(描画は隔離側, 組み立てはこちら、という分割の
 * シームであり、この分割が隔離の境界そのものである)。
 *
 * 加工はすべて**パース済み DOM の上**で行い、文字列に戻すのは最後の 1 回だけ
 * (`sanitizeHtml.ts` 冒頭の不変則)。サニタイズ済み文字列へ `<link…>` 除去や
 * `</head>` アンカー挿入を正規表現で当てると、属性値に置いた `<link rel=stylesheet>` や
 * `</head>` の字面にマッチして要素のタグ終端まで食い、直後のテキストが `on*` 属性として
 * 復活する。**ここへアンカー探索や部分除去を戻してはならない。**
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

// ここへ `buildPreviewDocument`(描画 + 組み立ての一括)を置いてはならない。
// 「描画」を含む以上アプリオリジンでのコンパイル経路になり、`renderJinja` の禁止を
// 素通りする抜け道になる。呼び出し側は `renderJinjaIsolated` で描画してから
// `assemblePreviewDocument` を呼ぶ 2 段で書くこと(この分割自体が隔離の境界である)。
