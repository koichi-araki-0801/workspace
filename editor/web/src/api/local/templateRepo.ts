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
  type TemplateInstance,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateSnapshot,
  templateFileName,
  templateIdFromFileName,
} from '@editor/shared';
import { attempt } from './attempt';
import { applyRedemptionMock, SERIES_FUND_CODES } from './fundRules';
import {
  allMetas,
  currentUser,
  defaultSkeleton,
  delay,
  fixtureCss,
  fixtureFilled,
  fixtureSample,
  fixtureTemplates,
  K,
  META_KEY,
  metaMatches,
  now,
  read,
  todayYmd,
  tx,
  uid,
  uniq,
  write,
} from './store';

// --- confirmSave steps (each a single localStorage read+write; the caller runs
//     them inside one tx() so a mid-way failure rolls every key back) -----------

/** Publish the edited body + per-fund shared CSS overrides. */
function putContentOverrides(req: ConfirmSaveRequest): void {
  const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
  htmlOverride[req.templateId] = req.html;
  write(K.htmlOverride, htmlOverride);
  const cssOverride = read<Record<string, string>>(K.cssOverride, {});
  cssOverride[req.fundCode] = req.css; // per-fund shared CSS
  write(K.cssOverride, cssOverride);
}

/** Mark the template published with the current editor + time. */
function publishMeta(templateId: string, who: string): void {
  const metaStore = read<Record<string, Partial<TemplateMeta>>>(META_KEY, {});
  metaStore[templateId] = { status: 'published', updatedAt: now(), updatedBy: who };
  write(META_KEY, metaStore);
}

/** Prepend a 確定保存 entry to the edit-history feed (keyed by historyId). */
function appendEditHistory(
  req: ConfirmSaveRequest,
  who: string,
  historyId: string,
  timestamp: string,
): void {
  const editHist = read<EditHistoryEntry[]>(K.editHist, []);
  editHist.unshift({
    id: historyId,
    templateId: req.templateId,
    user: who,
    timestamp,
    summary: '確定保存',
  });
  write(K.editHist, editHist);
}

/** Freeze the confirmed content so the version can be re-rendered for the visual
 *  compare screen. Keyed by the edit-history entry id. */
function freezeSnapshot(req: ConfirmSaveRequest, historyId: string, timestamp: string): void {
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
}

/** Keep the rendered report instance (values filled, no Jinja) alongside the
 *  template — the concrete document the editor produced. No-op without filledHtml. */
function putInstance(req: ConfirmSaveRequest, who: string): void {
  if (req.filledHtml === undefined) return;
  const instances = read<Record<string, TemplateInstance>>(K.instances, {});
  instances[req.templateId] = {
    templateId: req.templateId,
    html: req.filledHtml,
    css: req.css,
    savedAt: now(),
    savedBy: who,
  };
  write(K.instances, instances);
}

/** Drop the autosaved draft now that it has been confirmed. */
function clearDraft(templateId: string): void {
  const drafts = read<Record<string, TemplateDraft>>(K.drafts, {});
  delete drafts[templateId];
  write(K.drafts, drafts);
}

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
      // Static filled copy is only meaningful for an unedited fixture; once the
      // template HTML has been overridden, the editor re-fills it at load time.
      const filled = htmlOverride[id] ? '' : (fixtureFilled[meta.fileName] ?? '');
      return delay({ meta, html, css, filled });
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
      // 償還ファンド指定時は特定パーツを償還用パーツへ置換（モック）。
      if (req.isRedemption) baseHtml = applyRedemptionMock(baseHtml);
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
      // A freshly generated skeleton has no static fill; the editor renders one.
      return delay({ template: { meta, html: baseHtml, css, filled: '' } });
    }),

  resolveFund: (_companyCode: string, fundCode: string, _editionType: string) =>
    attempt(() => delay({ isSeriesFund: SERIES_FUND_CODES.has(fundCode) })),

  // シリーズ候補はコアラップ系（SERIES_FUND_CODES）のメンバーのみ。非シリーズは出さない。
  listSeriesFunds: (companyCode: string, _fundCode: string, editionType: string) =>
    attempt(() =>
      delay(
        allMetas().filter(
          (m) =>
            m.attributes.companyCode === companyCode &&
            m.attributes.editionType === editionType &&
            SERIES_FUND_CODES.has(m.attributes.fundCode),
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
    attempt(() =>
      // All writes commit together: a mid-way failure (e.g. quota) rolls every
      // touched key back to its pre-save state, so the store is never left
      // half-published. The notFound guard is inside the tx too, so a missing
      // meta also rolls back the writes above it.
      tx(
        [K.htmlOverride, K.cssOverride, META_KEY, K.editHist, K.snapshots, K.instances, K.drafts],
        () => {
          const who = currentUser()?.displayName ?? '不明';
          const historyId = uid('eh');
          const timestamp = now(); // shared by the edit-history entry and its snapshot

          putContentOverrides(req);
          publishMeta(req.templateId, who);
          appendEditHistory(req, who, historyId, timestamp);
          freezeSnapshot(req, historyId, timestamp);
          putInstance(req, who);
          clearDraft(req.templateId);

          const meta = allMetas().find((m) => m.id === req.templateId);
          if (!meta) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
          return delay(meta);
        },
      ),
    ),

  getSampleData: (fundCode: string) => attempt(() => delay(fixtureSample[fundCode] ?? {})),
};
