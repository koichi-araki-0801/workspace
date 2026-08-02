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
import { sanitizePreviewHtml } from '@/lib/sanitizeHtml';
import { htmlWorker } from '@/workers';

/** PDF 生成失敗時に表示する文言(原因 cause は別途ログへ記録する)。 */
export const PDF_ERROR_MSG = 'PDFの作成に失敗しました。時間をおいて再度お試しください。';

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
  const safeHtml = formatHtml(sanitizePreviewHtml(rendered.html));
  // トンボは CSS 一本で効かせる方針(`cropMarks.ts` 参照)。サーバ `inlineCss` が css を
  // `<style>` 化するため, ここで連結すればプレビュー表示と同じトンボが PDF にも乗る。
  const pdfCss = opts?.cropMarks ? `${css}\n${CROP_MARKS_CSS}` : css;
  return ok({ html: safeHtml, css: pdfCss });
}
