import {
  type ConfirmSaveRequest,
  type CreateHistoryEntry,
  type DropdownQuery,
  type EditHistoryEntry,
  type GenerateRequest,
  isErr,
  notFound,
  type SaveDraftRequest,
  type TemplateAttributes,
  type TemplateDraft,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateSnapshot,
  templateFileName,
  templateIdFromFileName,
} from '@editor/shared';
import { attempt } from './attempt';
import {
  allMetas,
  currentUser,
  defaultSkeleton,
  delay,
  fixtureCss,
  fixtureSample,
  fixtureTemplates,
  K,
  META_KEY,
  metaMatches,
  now,
  read,
  todayYmd,
  uid,
  uniq,
  write,
} from './store';

export const localTemplateRepo: TemplateRepository = {
  getDropdownOptions: (query: DropdownQuery) =>
    attempt(() => {
      const metas = allMetas();
      return delay({
        companyCodes: uniq(metas.map((m) => m.attributes.companyCode)),
        fundCodes: uniq(
          metas
            .filter((m) => !query.companyCode || m.attributes.companyCode === query.companyCode)
            .map((m) => m.attributes.fundCode),
        ),
        baseDates: uniq(
          metas.filter((m) => metaMatches(m, query)).map((m) => m.attributes.baseDate),
        ),
        editionTypes: uniq(
          metas.filter((m) => metaMatches(m, query)).map((m) => m.attributes.editionType),
        ),
      });
    }),

  listTemplates: (query: DropdownQuery) =>
    attempt(() => delay(allMetas().filter((m) => metaMatches(m, query)))),

  getTemplate: (id: string) =>
    attempt(() => {
      const meta = allMetas().find((m) => m.id === id);
      if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
      const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
      const cssOverride = read<Record<string, string>>(K.cssOverride, {});
      const html = htmlOverride[id] ?? fixtureTemplates[meta.fileName] ?? '';
      const css =
        cssOverride[meta.attributes.fundCode] ?? fixtureCss[meta.attributes.fundCode] ?? '';
      return delay({ meta, html, css });
    }),

  generate: (req: GenerateRequest) =>
    attempt(async () => {
      const user = currentUser();
      let baseHtml: string;
      if (req.basedOnTemplateId) {
        const baseRes = await localTemplateRepo.getTemplate(req.basedOnTemplateId);
        if (isErr(baseRes)) throw baseRes.error;
        baseHtml = baseRes.value.html;
      } else {
        baseHtml =
          fixtureTemplates[
            Object.keys(fixtureTemplates).find((f) =>
              f.startsWith(`${req.companyCode}_${req.fundCode}_`),
            ) ?? ''
          ] ?? defaultSkeleton();
      }
      const baseDate = todayYmd();
      const attrs: TemplateAttributes = {
        companyCode: req.companyCode,
        fundCode: req.fundCode,
        baseDate,
        editionType: req.editionType,
      };
      const fileName = templateFileName(attrs);
      const id = templateIdFromFileName(fileName);
      const meta: TemplateMeta = {
        id,
        attributes: attrs,
        fileName,
        status: 'draft',
        updatedAt: null,
        updatedBy: null,
      };
      // persist as draft override so it can be opened in the editor
      const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
      htmlOverride[id] = baseHtml;
      write(K.htmlOverride, htmlOverride);
      const createHist = read<CreateHistoryEntry[]>(K.createHist, []);
      createHist.unshift({
        id: uid('ch'),
        attributes: attrs,
        user: user?.displayName ?? '不明',
        timestamp: now(),
        basedOnTemplateId: req.basedOnTemplateId,
      });
      write(K.createHist, createHist);
      const css = fixtureCss[req.fundCode] ?? '';
      return delay({ template: { meta, html: baseHtml, css } });
    }),

  listSeriesFunds: (companyCode: string, _fundCode: string, editionType: string) =>
    attempt(() =>
      delay(
        allMetas().filter(
          (m) =>
            m.attributes.companyCode === companyCode && m.attributes.editionType === editionType,
        ),
      ),
    ),

  saveDraft: (req: SaveDraftRequest) =>
    attempt(() => {
      const user = currentUser();
      const drafts = read<Record<string, TemplateDraft>>(K.drafts, {});
      drafts[req.templateId] = {
        templateId: req.templateId,
        html: req.html,
        css: req.css,
        savedAt: now(),
        savedBy: user?.displayName ?? '不明',
      };
      write(K.drafts, drafts);
    }),

  getDraft: (templateId: string) =>
    attempt(() => {
      const drafts = read<Record<string, TemplateDraft>>(K.drafts, {});
      return delay(drafts[templateId] ?? null);
    }),

  confirmSave: (req: ConfirmSaveRequest) =>
    attempt(() => {
      const user = currentUser();
      const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
      htmlOverride[req.templateId] = req.html;
      write(K.htmlOverride, htmlOverride);
      const cssOverride = read<Record<string, string>>(K.cssOverride, {});
      cssOverride[req.fundCode] = req.css; // per-fund shared CSS
      write(K.cssOverride, cssOverride);

      const metaStore = read<Record<string, Partial<TemplateMeta>>>(META_KEY, {});
      metaStore[req.templateId] = {
        status: 'published',
        updatedAt: now(),
        updatedBy: user?.displayName ?? '不明',
      };
      write(META_KEY, metaStore);

      const editHist = read<EditHistoryEntry[]>(K.editHist, []);
      const historyId = uid('eh');
      const timestamp = now();
      editHist.unshift({
        id: historyId,
        templateId: req.templateId,
        user: user?.displayName ?? '不明',
        timestamp,
        summary: '確定保存',
      });
      write(K.editHist, editHist);

      // Freeze the confirmed content so the version can be re-rendered for the
      // visual compare screen. Keyed by the edit-history entry id.
      const snapshots = read<Record<string, TemplateSnapshot>>(K.snapshots, {});
      snapshots[historyId] = {
        historyId,
        templateId: req.templateId,
        html: req.html,
        css: req.css,
        fundCode: req.fundCode,
        timestamp,
      };
      write(K.snapshots, snapshots);

      // clear draft
      const drafts = read<Record<string, TemplateDraft>>(K.drafts, {});
      delete drafts[req.templateId];
      write(K.drafts, drafts);

      const meta = allMetas().find((m) => m.id === req.templateId);
      if (!meta) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
      return delay(meta);
    }),

  getSampleData: (fundCode: string) => attempt(() => delay(fixtureSample[fundCode] ?? {})),
};
