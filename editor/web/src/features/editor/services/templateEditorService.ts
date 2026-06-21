// =============================================================================
// templateEditorService.ts — editor の template 読込・draft 保存・履歴 service
// =============================================================================
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

/** editor が template を編集用に開くために必要な一式。 */
export interface EditorLoad {
  template: Template;
  /** 編集可能(Jinja-mask 済み)形式の body HTML — draft 由来、または新規に mask したもの。 */
  editableBody: string;
  css: string;
  /** canvas 選択を docs へ解決するための catalog parts。 */
  parts: PartCatalogItem[];
  /** editor タイトル用の表示 fund 名(sample data 由来。無ければファイル名にフォールバック)。 */
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
      // source ファイルを mask するより、autosave 済み draft(既に編集可能)を優先する。
      const draftRes = await templates.getDraft(id);
      if (isErr(draftRes)) return draftRes;

      const tpl = tplRes.value;
      const draft = draftRes.value;

      // sample data は値の差込と editor タイトルの両方を駆動する。ここでの失敗が
      // load をブロックしてはならない(差込は空値になるだけ)。
      let sample: SampleData = {};
      try {
        const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
        if (!isErr(sampleRes)) sample = sampleRes.value;
      } catch {
        /* sample は空のままにする */
      }

      // editor canvas は "filled" 形式(値を差込み、Jinja source は保持)を編集する。
      // 静的な fill を優先し、無ければ load 時に生成する。draft は既に編集可能/filled
      // 形式なので最優先となる。
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
