// =============================================================================
// nunjucksRender.ts — 描画済み HTML のプレビュー文書への組み立て
// =============================================================================
import { rebaseCssForDoc } from '@editor/shared';
import { formatCss, formatHtml } from './formatOutput';
import {
  appendPreviewStyle,
  sanitizePreviewRoot,
  serializePreviewRoot,
  stripExternalRefs,
} from './sanitizeHtml';

export interface RenderResult {
  html: string;
  error: string | null;
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
  // 外部 stylesheet `<link>`(例: `<link rel="stylesheet" href="../css/AM01_110024_交付版.css">`)は
  // サニタイザの許可リストが既に落としている。CSS は直後に inline 化するため不要で, 残ると
  // viewer が Blob 相対 URL で解決して 404 になり `@vivliostyle/core` のフェッチャが
  // ページ分割を中断する。ここは構造の上での二重化(版差と非サニタイズ経路の保険)。
  stripExternalRefs(root);
  // CSS は DOMPurify を通らないため `</style>` 脱出は `appendPreviewStyle` の中で潰す。
  // 本文 CSS は `css/<テンプレ>.css` の位置の CSS として書かれている(相対 url() は css/ 基準)。
  // `<style>` へ埋め込むと文書(`doc/`)基準になるので、ここで 1 回だけ付け替える。HTML 側の
  // `<style>` は触らない — 申請の filledHtml を本文として再入させる経路があり、触ると二重になる。
  appendPreviewStyle(root, formatCss(rebaseCssForDoc(css)), {
    'data-preview-css': '',
  });
  if (opts?.extraCss) appendPreviewStyle(root, opts.extraCss, { 'data-extra-css': '' });
  return serializePreviewRoot(root);
}

// ここへ `buildPreviewDocument`(描画 + 組み立ての一括)を置いてはならない。
// 「描画」を含む以上アプリオリジンでのコンパイル経路になり、`renderJinja` の禁止を
// 素通りする抜け道になる。呼び出し側は `renderJinjaIsolated` で描画してから
// `assemblePreviewDocument` を呼ぶ 2 段で書くこと(この分割自体が隔離の境界である)。
