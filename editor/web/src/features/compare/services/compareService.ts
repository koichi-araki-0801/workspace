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

/** Shown for any version-render failure (the cause is logged separately). */
export const COMPARE_RENDER_ERROR =
  'バージョンの表示に失敗しました。時間をおいて再度お試しください。';

/** A matched template plus its confirmed-version count, for the picker table. */
export interface CompareCandidate {
  meta: TemplateMeta;
  /** Number of confirmed versions (snapshots). 2+ are needed to compare. */
  versionCount: number;
}

/** One version rendered to HTML for the side-by-side block diff. */
export interface RenderedVersion {
  /** full HTML document (nunjucks-applied snapshot) */
  html: string;
  /** the version's per-fund CSS, for the preview iframe */
  css: string;
}

export interface CompareService {
  /** Templates matching the cascading-dropdown query (to pick the target). */
  listTemplates(query: DropdownQuery): Promise<Result<TemplateMeta[]>>;
  /** Matched templates enriched with their confirmed-version count. */
  listCandidates(query: DropdownQuery): Promise<Result<CompareCandidate[]>>;
  /** Confirmed versions (with snapshots) of a template, newest first. */
  listVersions(templateId: string): Promise<Result<TemplateVersionMeta[]>>;
  /** Render one version's snapshot to HTML (client-side, no server round-trip). */
  renderVersionHtml(historyId: string): Promise<Result<RenderedVersion>>;
}

export function createCompareService(
  templates: TemplateRepository,
  history: HistoryRepository,
): CompareService {
  return {
    listTemplates: (query) => templates.listTemplates(query),
    listVersions: (templateId) => history.listVersions(templateId),

    async listCandidates(query) {
      const metasRes = await templates.listTemplates(query);
      if (isErr(metasRes)) return metasRes;
      const candidates: CompareCandidate[] = [];
      for (const meta of metasRes.value) {
        const versRes = await history.listVersions(meta.id);
        if (isErr(versRes)) return versRes;
        candidates.push({ meta, versionCount: versRes.value.length });
      }
      return ok(candidates);
    },

    async renderVersionHtml(historyId) {
      const snapRes = await history.getSnapshot(historyId);
      if (isErr(snapRes)) return snapRes;
      const snap = snapRes.value;

      const sampleRes = await templates.getSampleData(snap.fundCode);
      if (isErr(sampleRes)) return sampleRes;

      // Same render path as the preview screen, but kept in the browser: the
      // block diff parses this HTML directly, so no PDF/server step is needed.
      const rendered = renderJinja(snap.html, sampleRes.value);
      if (rendered.error) return err(conflict(COMPARE_RENDER_ERROR, { cause: rendered.error }));
      return ok({ html: rendered.html, css: snap.css });
    },
  };
}

export const useCompareService = (): CompareService =>
  createCompareService(useTemplateRepo(), useHistoryRepo());
