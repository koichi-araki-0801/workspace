import {
  isErr,
  ok,
  type PartCatalogItem,
  type PartHistoryEntry,
  type PartRepository,
  type Result,
  type SampleData,
  type Template,
  type TemplateRepository,
} from '@editor/shared';
import { usePartRepo, useTemplateRepo } from '@/api/repositories';
import { toFilled } from '@/lib/fillJinja';
import { getBodyInner } from '@/lib/templateDoc';

/** Everything the editor needs to open a template for editing. */
export interface EditorLoad {
  template: Template;
  /** Body HTML in editable (Jinja-masked) form — from the draft, or freshly masked. */
  editableBody: string;
  css: string;
  /** Catalog parts, for resolving a canvas selection back to its docs. */
  parts: PartCatalogItem[];
  /** Human fund name for the editor title (from sample data; falls back to the file name). */
  fundName: string;
}

export interface TemplateEditorService {
  loadForEdit(id: string): Promise<Result<EditorLoad>>;
  saveDraft(id: string, html: string, css: string): Promise<Result<void>>;
  getPartHistory(templateId: string, partId: string): Promise<Result<PartHistoryEntry[]>>;
  recordPartChange(templateId: string, partId: string, change: string): Promise<Result<void>>;
}

export function createTemplateEditorService(
  templates: TemplateRepository,
  parts: PartRepository,
): TemplateEditorService {
  return {
    async loadForEdit(id) {
      const tplRes = await templates.getTemplate(id);
      if (isErr(tplRes)) return tplRes;
      const partsRes = await parts.listParts({});
      if (isErr(partsRes)) return partsRes;
      // Prefer an autosaved draft (already editable) over masking the source file.
      const draftRes = await templates.getDraft(id);
      if (isErr(draftRes)) return draftRes;

      const tpl = tplRes.value;
      const draft = draftRes.value;

      // Sample data drives both the value-fill and the editor title; a failure
      // here must never block the load (the fill just yields empty values).
      let sample: SampleData = {};
      try {
        const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
        if (!isErr(sampleRes)) sample = sampleRes.value;
      } catch {
        /* keep empty sample */
      }

      // The editor canvas edits the "filled" form (values substituted, Jinja
      // source preserved). Prefer a static fill; otherwise render one on load.
      // A draft is already in editable/filled form, so it wins.
      const filledBody = tpl.filled || toFilled(tpl.html, sample);
      const editableBody = draft ? draft.html : getBodyInner(filledBody);
      const css = draft ? draft.css : tpl.css;

      let fundName = tpl.meta.fileName.replace(/\.html$/, '');
      const fund = sample.fund as { name?: string } | undefined;
      if (fund?.name) fundName = fund.name;

      return ok({ template: tpl, editableBody, css, parts: partsRes.value, fundName });
    },

    saveDraft: (id, html, css) => templates.saveDraft({ templateId: id, html, css }),

    getPartHistory: (templateId, partId) => parts.getPartHistory(templateId, partId),

    recordPartChange: (templateId, partId, change) =>
      parts.recordPartChange(templateId, partId, change),
  };
}

export const useTemplateEditorService = (): TemplateEditorService =>
  createTemplateEditorService(useTemplateRepo(), usePartRepo());
