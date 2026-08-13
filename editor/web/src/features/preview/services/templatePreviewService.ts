// =============================================================================
// templatePreviewService.ts — プレビュー画面のロード/PDF 出力サービス
// =============================================================================
import {
  apiPaths,
  applyTemplateAttributes,
  conflict,
  err,
  type HistoryRepository,
  isErr,
  ok,
  type Result,
  type SampleData,
  type Template,
  type TemplateRepository,
  unexpected,
} from '@editor/shared';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { apiUrl } from '@/api/rest/http';
import { logError } from '@/lib/appError';
import { formatCss } from '@/lib/formatOutput';
import { assemblePreviewDocument } from '@/lib/nunjucksRender';
import { PDF_ERROR_MSG, renderPdfDocument } from '@/lib/pdfDocument';
import { renderJinjaIsolated } from '@/lib/renderHostClient';
import { replaceBodyInner } from '@/lib/templateDoc';
import { htmlWorker } from '@/workers';

// 文書組み立て(隔離描画 → sanitize → format)は結合 PDF と共用のため
// `lib/pdfDocument.ts` が持つ。文言定数は既存の import 元を保つため再エクスポートする。
export { PDF_ERROR_MSG };

const RENDER_ERROR_MSG = 'プレビューを表示できませんでした。テンプレートの内容をご確認ください。';

interface PreviewLoad {
  template: Template;
  sample: SampleData;
  /** Jinja を復元した HTML(draft があれば適用済み)。save と PDF で使う。 */
  restoredHtml: string;
  css: string;
  /** プレビュー iframe 用の自己完結 HTML ドキュメント。 */
  previewDoc: string;
  /** ユーザー向けレンダリングエラー。正常にレンダリングできた場合は null。 */
  renderError: string | null;
}

interface TemplatePreviewService {
  loadForPreview(id: string): Promise<Result<PreviewLoad>>;
  /**
   * テンプレートをサーバー経由で PDF blob にレンダリングする。`cropMarks` が true のとき
   * トンボ用 CSS(`CROP_MARKS_CSS`)を css へ連結する(プレビュー表示と同じ見た目にする)。
   */
  renderPdf(
    html: string,
    css: string,
    sample: SampleData,
    cropMarks: boolean,
  ): Promise<Result<Blob>>;
  recordPdfExport(id: string): Promise<Result<void>>;
}

export function createTemplatePreviewService(
  templates: TemplateRepository,
  history: HistoryRepository,
): TemplatePreviewService {
  return {
    async loadForPreview(id) {
      const tplRes = await templates.getTemplate(id);
      if (isErr(tplRes)) return tplRes;
      const tpl = tplRes.value;

      const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
      if (isErr(sampleRes)) return sampleRes;
      // 版種・基準日(ファイル名由来)を被せる。getSampleData はファンド単位で属性を持たない。
      const sample = applyTemplateAttributes(sampleRes.value, tpl.meta.attributes);

      const draftRes = await templates.getDraft(id);
      if (isErr(draftRes)) return draftRes;
      const draft = draftRes.value;

      let restoredHtml: string;
      let css: string;
      if (draft) {
        // Jinja 復元(DOM 重処理)は Worker(linkedom)で実行しメインを塞がない。`pretty` で
        // 復元 HTML を整形し、確定保存される `data/templates` が git に読める形になる。
        const restoredBody = await htmlWorker.toTemplate(draft.html, {
          asFragment: true,
          pretty: true,
        });
        restoredHtml = replaceBodyInner(tpl.html, restoredBody);
        css = formatCss(draft.css);
      } else {
        // draft 無し(編集前)は生テンプレをそのまま使う。生 Jinja HTML は整形しない(構文破壊
        // 回避)。CSS は静的なので整形して保存形を揃える(整形済みでも冪等)。
        restoredHtml = tpl.html;
        css = formatCss(tpl.css);
      }

      // 描画は opaque オリジンの iframe(`renderHostClient`)、サニタイズ + 文書組み立て
      // (コンパイルを伴わない安価な処理)はメインで行う。Worker へ載せていた頃は同一
      // オリジンで nunjucks をコンパイルしており、隔離としては何も守っていなかった。
      const rendered = await renderJinjaIsolated(restoredHtml, sample);
      let previewDoc = '';
      let renderError: string | null = null;
      if (rendered.error) {
        logError(unexpected('preview render failed', { cause: rendered.error }));
        renderError = RENDER_ERROR_MSG;
      } else {
        previewDoc = assemblePreviewDocument(rendered.html, css);
      }
      return ok({ template: tpl, sample, restoredHtml, css, previewDoc, renderError });
    },

    async renderPdf(html, css, sample, cropMarks) {
      try {
        const doc = await renderPdfDocument(html, css, sample, { cropMarks });
        if (isErr(doc)) return doc;
        const res = await fetch(apiUrl(apiPaths.build), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc.value),
        });
        if (!res.ok) return err(conflict(PDF_ERROR_MSG, { cause: `HTTP ${res.status}` }));
        return ok(await res.blob());
      } catch (e) {
        return err(conflict(PDF_ERROR_MSG, { cause: e }));
      }
    },

    recordPdfExport: (id) => history.recordPdfExport(id),
  };
}

export const useTemplatePreviewService = (): TemplatePreviewService =>
  createTemplatePreviewService(useTemplateRepo(), useHistoryRepo());
