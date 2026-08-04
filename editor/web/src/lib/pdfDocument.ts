// =============================================================================
// pdfDocument.ts — サーバ PDF ビルドへ渡す文書(HTML+CSS)の組み立て
// =============================================================================
// 元は `templatePreviewService.renderPdf` の一部。結合 PDF(`mergePdfService`)が同じ
// 「renderJinja → sanitize → format」を必要とするため共通化した。単体 PDF と結合 PDF の
// 入力文書がここ 1 箇所で同じ扱いになることが、見た目の一致(単体で出した頁 = 結合中の頁)
// の担保でもある。

import { conflict, err, ok, type Result, type SampleData } from '@editor/shared';
import { CROP_MARKS_CSS } from '@/lib/cropMarks';
import { formatHtml } from '@/lib/formatOutput';
import { findExternalRefsInCss } from '@/lib/sanitizeCss';
import { sanitizePreviewHtml } from '@/lib/sanitizeHtml';
import { htmlWorker } from '@/workers';

/** PDF 生成失敗時に表示する文言(原因 cause は別途ログへ記録する)。 */
export const PDF_ERROR_MSG = 'PDFの作成に失敗しました。時間をおいて再度お試しください。';

/** CSS が外部参照を含むため PDF を作らなかったときの文言(該当参照は cause へ入れる)。 */
export const PDF_CSS_EXTERNAL_REF_MSG =
  'CSSに外部参照（@import / 絶対URLのurl() / 引用符付きの絶対URL）が含まれるため' +
  'PDFを作成できません。' +
  'フォントや画像はテンプレートに同梱するか相対パスで指定してください。';

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
  const rendered = await htmlWorker.renderJinja(html, sample);
  if (rendered.error) return err(conflict(PDF_ERROR_MSG, { cause: rendered.error }));
  // サーバの headless ブラウザでレンダリングされる前に能動コンテンツを除去する
  // (プレビューと同じ保存型 XSS / スクリプト実行対策)。Jinja 解決済みの純 HTML なので
  // 整形は安全 — PDF 入力を読める形にする(`css` は呼び出し側で整形済み)。
  // 整形はサニタイズの**前**に置く: 出力バイトを最後に決めるのは HTML 仕様のパーサ
  // (DOMPurify 内蔵)でなければならず、js-beautify を後段にすると保証がそこで途切れる
  // (`sanitizeHtml.ts` 冒頭の不変則)。
  const safeHtml = sanitizePreviewHtml(formatHtml(rendered.html));
  // トンボは CSS 一本で効かせる方針(`cropMarks.ts` 参照)。サーバ `inlineCss` が css を
  // `<style>` 化するため, ここで連結すればプレビュー表示と同じトンボが PDF にも乗る。
  const pdfCss = opts?.cropMarks ? `${css}\n${CROP_MARKS_CSS}` : css;
  // ここの検査は**早期フィードバック専用**であって関門ではない。関門はサーバの build 入口
  // (`server/src/security/externalRefs.ts`)にあり、判定関数は `@editor/shared` の 1 つを共有する。
  // ブラウザ側を唯一の関門にしていた版は、公開 API `POST /api/build` へ直接 POST すれば
  // 無検査で headless へ届いた(UI を経由しない経路が関門を迂回する形)。
  const refs = findExternalRefsInCss(pdfCss);
  if (refs.length > 0) {
    return err(conflict(PDF_CSS_EXTERNAL_REF_MSG, { cause: refs.slice(0, 5).join(', ') }));
  }
  return ok({ html: safeHtml, css: pdfCss });
}
