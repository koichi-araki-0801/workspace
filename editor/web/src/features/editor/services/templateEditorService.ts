// =============================================================================
// templateEditorService.ts — editor の template 読込・draft 保存・履歴 service
// =============================================================================
import {
  applyEdition,
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
import { getBodyInner } from '@/lib/templateDoc';
import { htmlWorker } from '@/workers';

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
  /** 未確定の draft が既に存在したか(前回セッションの編集途中)。dirty 初期化に使う。 */
  hasDraft: boolean;
}

export interface TemplateEditorService {
  loadForEdit(id: string): Promise<Result<EditorLoad>>;
  saveDraft(id: string, html: string, css: string): Promise<Result<void>>;
  /** 確定保存せずメニューへ戻る際に未確定 draft を破棄する。 */
  discardDraft(id: string): Promise<Result<void>>;
  listPartHistory(templateId: string): Promise<Result<PartHistoryEntry[]>>;
  recordPartChange(templateId: string, partKey: string, change: string): Promise<Result<void>>;
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
        // 版種(ファイル名由来)を被せる。getSampleData はファンド単位で版種を持たない。
        if (!isErr(sampleRes))
          sample = applyEdition(sampleRes.value, tpl.meta.attributes.editionType);
      } catch {
        /* sample は空のままにする */
      }

      // editor canvas は "filled" 形式(値を差込み、Jinja source は保持)を編集する。
      // 静的な fill を優先し、無ければ load 時に生成する。draft は既に編集可能/filled
      // 形式なので最優先となる。
      // 値差込(filled)生成は Worker(nunjucks)で実行しメインを塞がない。静的 filled が
      // あればそれを優先する。
      const filledBody = tpl.filled || (await htmlWorker.toFilled(tpl.html, sample));
      const editableBody = draft ? draft.html : getBodyInner(filledBody);
      const css = draft ? draft.css : tpl.css;

      let fundName = tpl.meta.fileName.replace(/\.html$/, '');
      const fund = sample.fund as { name?: string } | undefined;
      if (fund?.name) fundName = fund.name;

      return ok({
        template: tpl,
        editableBody,
        css,
        parts: partsRes.value,
        fundName,
        hasDraft: !!draft,
      });
    },

    saveDraft: (id, html, css) => templates.saveDraft({ templateId: id, html, css }),

    discardDraft: (id) => templates.discardDraft(id),

    listPartHistory: (templateId) => parts.listPartHistory(templateId),

    recordPartChange: (templateId, partKey, change) =>
      parts.recordPartChange(templateId, partKey, change),
  };
}

export const useTemplateEditorService = (): TemplateEditorService =>
  createTemplateEditorService(useTemplateRepo(), usePartRepo());
