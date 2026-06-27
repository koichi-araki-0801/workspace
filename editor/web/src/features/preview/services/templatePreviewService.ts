// =============================================================================
// templatePreviewService.ts — プレビュー画面のロード/確定保存/PDF 出力サービス
// =============================================================================
import {
  apiPaths,
  applyEdition,
  type ConfirmSaveRequest,
  conflict,
  err,
  type HistoryRepository,
  isErr,
  ok,
  type Result,
  type SampleData,
  type Template,
  type TemplateMeta,
  type TemplateRepository,
  unexpected,
} from '@editor/shared';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { apiUrl } from '@/api/rest/http';
import { logError } from '@/lib/appError';
import { toTemplate } from '@/lib/jinjaMask';
import { buildPreviewDocument, renderJinja } from '@/lib/nunjucksRender';
import { sanitizePreviewHtml } from '@/lib/sanitizeHtml';
import { replaceBodyInner } from '@/lib/templateDoc';

/** PDF 生成失敗時に表示する文言(原因 cause は別途ログへ記録する)。 */
export const PDF_ERROR_MSG = 'PDFの作成に失敗しました。時間をおいて再度お試しください。';
const RENDER_ERROR_MSG = 'プレビューを表示できませんでした。テンプレートの内容をご確認ください。';

export interface PreviewLoad {
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

export interface TemplatePreviewService {
  loadForPreview(id: string): Promise<Result<PreviewLoad>>;
  confirmSave(req: ConfirmSaveRequest): Promise<Result<TemplateMeta>>;
  /** テンプレートをサーバー経由で PDF blob にレンダリングする。 */
  renderPdf(html: string, css: string, sample: SampleData): Promise<Result<Blob>>;
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
      // 版種(ファイル名由来)を被せる。getSampleData はファンド単位で版種を持たない。
      const sample = applyEdition(sampleRes.value, tpl.meta.attributes.editionType);

      const draftRes = await templates.getDraft(id);
      if (isErr(draftRes)) return draftRes;
      const draft = draftRes.value;

      let restoredHtml: string;
      let css: string;
      if (draft) {
        const restoredBody = toTemplate(draft.html, { asFragment: true });
        restoredHtml = replaceBodyInner(tpl.html, restoredBody);
        css = draft.css;
      } else {
        restoredHtml = tpl.html;
        css = tpl.css;
      }

      const doc = buildPreviewDocument(restoredHtml, css, sample);
      let renderError: string | null = null;
      if (doc.error) {
        logError(unexpected('preview render failed', { cause: doc.error }));
        renderError = RENDER_ERROR_MSG;
      }
      return ok({ template: tpl, sample, restoredHtml, css, previewDoc: doc.html, renderError });
    },

    confirmSave: (req) => templates.confirmSave(req),

    async renderPdf(html, css, sample) {
      try {
        const rendered = renderJinja(html, sample);
        if (rendered.error) return err(conflict(PDF_ERROR_MSG, { cause: rendered.error }));
        // サーバの headless ブラウザでレンダリングされる前に能動コンテンツを除去する
        // (プレビューと同じ保存型 XSS / スクリプト実行対策)。
        const safeHtml = sanitizePreviewHtml(rendered.html);
        const res = await fetch(apiUrl(apiPaths.build), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: safeHtml, css }),
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
