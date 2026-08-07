// =============================================================================
// pdfDocument.ts — サーバ PDF ビルドへ渡す文書(HTML+CSS)の組み立て
// =============================================================================
// 元は `templatePreviewService.renderPdf` の一部。結合 PDF(`mergePdfService`)が同じ
// 「隔離描画 → sanitize → format」を必要とするため共通化した。単体 PDF と結合 PDF の
// 入力文書がここ 1 箇所で同じ扱いになることが、見た目の一致(単体で出した頁 = 結合中の頁)
// の担保でもある。

import {
  conflict,
  err,
  fetchUrlAttrsFor,
  findExternalRefsInTag,
  ok,
  type Result,
  type SampleData,
} from '@editor/shared';
import { CROP_MARKS_CSS } from '@/lib/cropMarks';
import { formatHtml } from '@/lib/formatOutput';
import { renderJinjaIsolated } from '@/lib/renderHostClient';
import { findExternalRefsInCss } from '@/lib/sanitizeCss';
import { sanitizePdfRoot, serializePreviewRoot } from '@/lib/sanitizeHtml';

/** PDF 生成失敗時に表示する文言(原因 cause は別途ログへ記録する)。 */
export const PDF_ERROR_MSG = 'PDFの作成に失敗しました。時間をおいて再度お試しください。';

/** CSS/HTML が外部参照を含むため PDF を作らなかったときの文言(該当参照は cause へ入れる)。 */
export const PDF_CSS_EXTERNAL_REF_MSG =
  'CSSまたはHTMLに外部参照（@import / 絶対URLのurl() / 絶対URLのhref・src）が含まれるため' +
  'PDFを作成できません。' +
  'フォントや画像やスクリプトはテンプレートに同梱するか、' +
  '同梱資産への相対パス（css/… fonts/… js/…）で指定してください。';

/**
 * サニタイズ済み DOM から、オリジン外を指す取得系属性を洗い出す(早期フィードバック用)。
 * 判定は `@editor/shared` の `findExternalRefsInTag` — サーバの関門と**同じ関数**で、
 * ブラウザ側に別実装のブロックリストを作らない。同梱資産への相対参照は通る。
 */
function findExternalRefsInDom(root: Element): string[] {
  const refs: string[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (fetchUrlAttrsFor(tag).length === 0) continue;
    const attrs = Array.from(el.attributes).map((a) => ({ name: a.name, value: a.value }));
    refs.push(...findExternalRefsInTag(tag, attrs));
  }
  return refs;
}

/**
 * テンプレ HTML+CSS+サンプルデータから、サーバ PDF ビルドへ渡せる安全な文書を組み立てる。
 * `cropMarks` が true のときトンボ用 CSS(`CROP_MARKS_CSS`)を css へ連結する。
 */
export async function renderPdfDocument(
  html: string,
  css: string,
  sample: SampleData,
  opts?: { cropMarks?: boolean },
): Promise<Result<{ html: string; css: string }>> {
  // Jinja のコンパイルは opaque オリジンの iframe(`renderHostClient`)で行う。ここへ来る
  // `html` は申請者・生成器が書いたテンプレ本文で、nunjucks は**コンパイラ**であるため
  // アプリのオリジンで走らせるとテンプレの字面がそのまま JS 実行になる(所見 F1)。
  const rendered = await renderJinjaIsolated(html, sample);
  if (rendered.error) return err(conflict(PDF_ERROR_MSG, { cause: rendered.error }));
  // **script は落とさない**(`sanitizePdfRoot`)。テンプレの JS は開発者が生成時に埋め込む
  // 正当なコンテンツであり、守り方は除去ではなく隔離(サーバ側の egress 遮断 + 作業
  // ディレクトリ封じ込め)+ 出所の固定(`security/templateScripts.ts` の不変性照合)である。
  // `on*` 属性・`javascript:` URL・危険要素の除去はそのまま効いている。
  //
  // ⚠ PDF 組版で動くのは **インライン `<script>` だけ**(実測)。`@vivliostyle/core` は文書を
  // `fetch` + `DOMParser` で読み、script 要素を**ビューアの window へ作り直して**実行する
  // (`scripts.ts` の `loadScript` / `allowScripts` 既定 true)。このとき `src` の解決基準が
  // ビューアアプリの URL になるため、`src="js/x.js"` は `/__vivliostyle-viewer/js/x.js` を
  // 取りに行って 404 になる(中継ログで実測)。`DOMContentLoaded` もビューアの window では
  // 発火しない。**テンプレ JS は body 末尾のインライン script に置くこと。**
  // 整形はサニタイズの**前**に置く: 出力バイトを最後に決めるのは HTML 仕様のパーサ
  // (DOMPurify 内蔵)でなければならず、js-beautify を後段にすると保証がそこで途切れる
  // (`sanitizeHtml.ts` 冒頭の不変則)。
  const root = sanitizePdfRoot(formatHtml(rendered.html));
  // トンボは CSS 一本で効かせる方針(`cropMarks.ts` 参照)。サーバ `inlineCss` が css を
  // `<style>` 化するため, ここで連結すればプレビュー表示と同じトンボが PDF にも乗る。
  const pdfCss = opts?.cropMarks ? `${css}\n${CROP_MARKS_CSS}` : css;
  // ここの検査は**早期フィードバック専用**であって関門ではない。関門はサーバの build 入口
  // (`server/src/security/externalRefs.ts`)にあり、判定関数は `@editor/shared` の 1 つを共有する。
  // ブラウザ側を唯一の関門にしていた版は、公開 API `POST /api/build` へ直接 POST すれば
  // 無検査で headless へ届いた(UI を経由しない経路が関門を迂回する形)。
  const refs = [...findExternalRefsInCss(pdfCss), ...findExternalRefsInDom(root)];
  if (refs.length > 0) {
    return err(conflict(PDF_CSS_EXTERNAL_REF_MSG, { cause: refs.slice(0, 5).join(', ') }));
  }
  return ok({ html: serializePreviewRoot(root), css: pdfCss });
}
