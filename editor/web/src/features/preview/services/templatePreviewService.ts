import {
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
import { logError } from '@/lib/appError';
import { toTemplate } from '@/lib/jinjaMask';
import { buildPreviewDocument, renderJinja } from '@/lib/nunjucksRender';
import { replaceBodyInner } from '@/lib/templateDoc';

/** Shown for any PDF generation failure (the cause is logged separately). */
export const PDF_ERROR_MSG = 'PDFの作成に失敗しました。時間をおいて再度お試しください。';
const RENDER_ERROR_MSG = 'プレビューを表示できませんでした。テンプレートの内容をご確認ください。';

export interface PreviewLoad {
  template: Template;
  sample: SampleData;
  /** Jinja-restored HTML (draft applied if present), used for save & PDF. */
  restoredHtml: string;
  css: string;
  /** Self-contained HTML document for the preview iframe. */
  previewDoc: string;
  /** User-facing render error, or null when the preview rendered cleanly. */
  renderError: string | null;
}

export interface TemplatePreviewService {
  loadForPreview(id: string): Promise<Result<PreviewLoad>>;
  confirmSave(req: ConfirmSaveRequest): Promise<Result<TemplateMeta>>;
  /** Render the template to a PDF blob via the server. */
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
      const sample = sampleRes.value;

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
        const res = await fetch('/api/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: rendered.html, css }),
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
