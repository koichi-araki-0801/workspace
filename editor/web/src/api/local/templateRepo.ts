// =============================================================================
// templateRepo.ts — テンプレートの一覧/取得/生成/保存の local 実装
// =============================================================================
import {
  buildSampleData,
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
  fixtureTemplates,
  fundMaster,
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

// ── confirmSave steps ──
// 各ステップは単一の localStorage read+write。呼び出し元が 1 つの `tx()` 内で実行し、
// 途中失敗時に全キーをロールバックする。

/** 編集後の本文 + fund 単位の共有 CSS override を公開する。 */
function putContentOverrides(req: ConfirmSaveRequest): void {
  const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
  htmlOverride[req.templateId] = req.html;
  write(K.htmlOverride, htmlOverride);
  const cssOverride = read<Record<string, string>>(K.cssOverride, {});
  cssOverride[req.fundCode] = req.css; // fund 単位の共有 CSS
  write(K.cssOverride, cssOverride);
}

/** テンプレートを現在の編集者 + 時刻で published にする。 */
function publishMeta(templateId: string, who: string): void {
  const metaStore = read<Record<string, Partial<TemplateMeta>>>(META_KEY, {});
  metaStore[templateId] = { status: 'published', updatedAt: now(), updatedBy: who };
  write(META_KEY, metaStore);
}

/** edit-history フィードへ確定保存 entry を先頭追加する(キーは `historyId`)。 */
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

/** 確定コンテンツを凍結し、visual compare 画面で版を再描画できるようにする。
 *  キーは edit-history entry の id。 */
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

/** 描画済み report instance(値差込済み・Jinja なし)をテンプレートと併せて保存する。
 *  editor が生成した具体ドキュメントそのもの。`filledHtml` が無ければ no-op。 */
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

/** 確定済みになった自動保存 draft を破棄する。 */
function clearDraft(templateId: string): void {
  const drafts = read<Record<string, TemplateDraft>>(K.drafts, {});
  delete drafts[templateId];
  write(K.drafts, drafts);
}

export const localTemplateRepo: TemplateRepository = {
  getDropdownOptions: (query: DropdownQuery) =>
    attempt(() => {
      const metas = allMetas();
      // 各候補は「自分より上位の選択」だけで絞る(自分自身・下位は含めない)。そうしないと
      // 最下位の版種を選んだ後にその版種だけへ候補が潰れ、別の版種(例: 全体版)へ戻せない。
      const matchesUpper = (m: TemplateMeta, fields: (keyof TemplateAttributes)[]): boolean =>
        fields.every((f) => !query[f] || m.attributes[f] === query[f]);
      return delay({
        companyCodes: uniq(metas.map((m) => m.attributes.companyCode)),
        fundCodes: uniq(
          metas.filter((m) => matchesUpper(m, ['companyCode'])).map((m) => m.attributes.fundCode),
        ),
        baseDates: uniq(
          metas
            .filter((m) => matchesUpper(m, ['companyCode', 'fundCode']))
            .map((m) => m.attributes.baseDate),
        ),
        editionTypes: uniq(
          metas
            .filter((m) => matchesUpper(m, ['companyCode', 'fundCode', 'baseDate']))
            .map((m) => m.attributes.editionType),
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
      // 静的な filled コピーは未編集 fixture でのみ意味を持つ。テンプレート HTML が
      // override 済みなら、editor がロード時に再度 fill する。
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
      // 償還ファンド指定時は特定パーツを償還用パーツへ置換(モック)。
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
      // editor で開けるよう draft override として永続化する。
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
      // 新規生成 skeleton には静的 fill が無い。editor が 1 つ描画する。
      return delay({ template: { meta, html: baseHtml, css, filled: '' } });
    }),

  resolveFund: (_companyCode: string, fundCode: string, _editionType: string) =>
    attempt(() => delay({ isSeriesFund: SERIES_FUND_CODES.has(fundCode) })),

  // シリーズ候補はコアラップ系(`SERIES_FUND_CODES`)のメンバーのみ。非シリーズは出さない。
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

  // 確定保存せずメニューへ戻った際の下書き破棄。`clearDraft` を公開して冪等に削除する。
  discardDraft: (templateId: string) =>
    attempt(() => {
      clearDraft(templateId);
      return delay(undefined);
    }),

  confirmSave: (req: ConfirmSaveRequest) =>
    attempt(() =>
      // 全 write を一括コミットする: 途中失敗(例: quota)は触れた全キーを保存前状態へ
      // ロールバックし、ストアが half-published で残らないようにする。`notFound` ガードも
      // tx 内にあるため、meta 欠落時はその上の write も巻き戻る。
      tx(
        [K.htmlOverride, K.cssOverride, META_KEY, K.editHist, K.snapshots, K.instances, K.drafts],
        () => {
          const who = currentUser()?.displayName ?? '不明';
          const historyId = uid('eh');
          const timestamp = now(); // edit-history entry とその snapshot で共有する

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

  // パーツ別共通ダミー(`sampleCommon`)に funds.json のファンド固有値だけ被せて返す。
  // 版種(ファイル名由来)はテンプレを開く文脈で `applyEdition` が上書きする。
  getSampleData: (fundCode: string) =>
    attempt(() => delay(buildSampleData(fundMaster[fundCode], fundCode))),
};
