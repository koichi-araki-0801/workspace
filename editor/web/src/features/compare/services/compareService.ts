import {
  conflict,
  type DropdownQuery,
  err,
  type HistoryRepository,
  isErr,
  ok,
  type Result,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateVersionMeta,
} from '@editor/shared';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { renderJinja } from '@/lib/nunjucksRender';

/** Shown for any PDF generation failure (the cause is logged separately). */
export const COMPARE_PDF_ERROR = 'PDFの作成に失敗しました。時間をおいて再度お試しください。';

export interface CompareService {
  /** Templates matching the cascading-dropdown query (to pick the target). */
  listTemplates(query: DropdownQuery): Promise<Result<TemplateMeta[]>>;
  /** Confirmed versions (with snapshots) of a template, newest first. */
  listVersions(templateId: string): Promise<Result<TemplateVersionMeta[]>>;
  /** Re-render one version's snapshot to a PDF blob via the server. */
  renderVersion(historyId: string): Promise<Result<Blob>>;
}

export function createCompareService(
  templates: TemplateRepository,
  history: HistoryRepository,
): CompareService {
  return {
    listTemplates: (query) => templates.listTemplates(query),
    listVersions: (templateId) => history.listVersions(templateId),

    async renderVersion(historyId) {
      const snapRes = await history.getSnapshot(historyId);
      if (isErr(snapRes)) return snapRes;
      const snap = snapRes.value;

      const sampleRes = await templates.getSampleData(snap.fundCode);
      if (isErr(sampleRes)) return sampleRes;

      // Mirror the preview screen's PDF path: nunjucks-render the raw template,
      // then let the server inline the CSS and rasterize via Edge/vivliostyle.
      const rendered = renderJinja(snap.html, sampleRes.value);
      if (rendered.error) return err(conflict(COMPARE_PDF_ERROR, { cause: rendered.error }));
      try {
        const res = await fetch('/api/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: rendered.html, css: snap.css }),
        });
        if (!res.ok) return err(conflict(COMPARE_PDF_ERROR, { cause: `HTTP ${res.status}` }));
        return ok(await res.blob());
      } catch (e) {
        return err(conflict(COMPARE_PDF_ERROR, { cause: e }));
      }
    },
  };
}

export const useCompareService = (): CompareService =>
  createCompareService(useTemplateRepo(), useHistoryRepo());
