// =============================================================================
// templateRepo.ts — テンプレートの一覧/取得/生成/保存の local 実装
// =============================================================================
import {
  assertTemplateId,
  buildSampleData,
  type ConfirmSaveRequest,
  type CreateHistoryEntry,
  conflict,
  cssFileNameOf,
  type DropdownQuery,
  type DropdownScope,
  EDITION_SYNC_PAIRS,
  type EditHistoryEntry,
  editHistoryRowId,
  editingMarkerMessage,
  findEditingMarkers,
  type GenerateRequest,
  isErr,
  notFound,
  pairedTemplateId,
  parseAnyTemplateFileName,
  parseSkeletonFileName,
  type ReviewRequest,
  type SaveDraftRequest,
  type SkeletonAttributes,
  sampleCommon,
  skeletonFileName,
  type TemplateAttributes,
  type TemplateDraft,
  type TemplateInstance,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateSnapshot,
  templateIdFromFileName,
  validation,
} from '@editor/shared';
import { attempt } from './attempt';
import { applyRedemptionMock, SERIES_FUND_CODES } from './fundRules';
import {
  allMetas,
  currentUser,
  defaultSkeleton,
  delay,
  fixtureCss,
  fixtureTemplates,
  fixtureValues,
  fundMaster,
  K,
  META_KEY,
  metaMatches,
  now,
  read,
  resolveFilled,
  tx,
  uid,
  uniqSorted,
  write,
} from './store';

// ── confirmSaveLocal steps ──
// 各ステップは単一の localStorage read+write。呼び出し元が 1 つの `tx()` 内で実行し、
// 途中失敗時に全キーをロールバックする。

/**
 * テンプレ単位の CSS(承認済み override → fixtures の順)。名前は server と同じく `cssFileNameOf`。
 * どちらにも無ければ undefined(呼び出し側が `cssMissing` を立てる)。
 */
function localCssOf(templateId: string): string | undefined {
  const name = cssFileNameOf(templateId);
  if (name === null) return undefined;
  const cssOverride = read<Record<string, string>>(K.cssOverride, {});
  return cssOverride[name] ?? fixtureCss[name];
}

/** 編集後の本文 + テンプレ単位の CSS override を公開する。 */
function putContentOverrides(req: ConfirmSaveRequest): void {
  // local の承認の唯一の書き込み点(server の `applyConfirmedWrite` の関所に当たる)。申請の
  // 入口より前に積まれた申請もここで止まり、`tx` の中で投げるのでストアは巻き戻る。
  const marked = editingMarkerMessage(findEditingMarkers(req.html), req.templateId);
  if (marked !== null) throw validation(marked);
  // 編集タブの承認は値入り HTML を上書きする(server の filled/ と同じ契約)。Jinja は据え置く。
  // 作成タブの承認は Jinja テンプレそのものを上書きする。書き先が違うだけで手順は同じ。
  const key = req.origin === 'edit' ? K.filledOverride : K.htmlOverride;
  const override = read<Record<string, string>>(key, {});
  override[req.templateId] = req.html;
  write(key, override);

  // CSS はテンプレ単位(基準日違いの文書で共有)。キーは CSS のファイル名。
  const name = cssFileNameOf(req.templateId);
  if (name !== null) {
    const cssOverride = read<Record<string, string>>(K.cssOverride, {});
    cssOverride[name] = req.css;
    write(K.cssOverride, cssOverride);
  }
}

/** 確定保存の編集者と時刻を記録する。`status` は書かない(値入り HTML の有無だけから
 *  導く。`store.ts` の `resolveFilled`)。 */
function stampMeta(templateId: string, who: string): void {
  const metaStore = read<Record<string, Partial<TemplateMeta>>>(META_KEY, {});
  metaStore[templateId] = { updatedAt: now(), updatedBy: who };
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
    id: editHistoryRowId(historyId, req.templateId),
    historyId,
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
    fundCode: parseAnyTemplateFileName(`${req.templateId}.html`)?.fundCode ?? '',
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

/** 確定反映と同一 tx でコミットしたい呼び出し元の書込(承認ワークフローの申請状態)。 */
interface ConfirmSaveExtra {
  /** ロールバック対象へ加える localStorage キー。 */
  keys: readonly string[];
  /** tx 内で実行する同期の書込。 */
  commit: () => void;
}

/**
 * local の templates/ 相当: 作成タブの承認(`confirmSaveLocal`)を通ったテンプレート(3 つ区切り)。
 * 生成しただけ(server の pending/ 相当)は `updatedAt` を持たないので数えない。会社コードは
 * 大文字小文字を区別しない(server の `findTemplateId` と同じ)。
 */
function confirmedSkeleton(
  companyCode: string,
  fundCode: string,
  editionType: string,
): TemplateMeta | undefined {
  return allMetas().find(
    (m) =>
      parseSkeletonFileName(m.fileName) !== null &&
      m.updatedAt !== null &&
      m.attributes.companyCode.toLowerCase() === companyCode.toLowerCase() &&
      m.attributes.fundCode === fundCode &&
      m.attributes.editionType === editionType,
  );
}

/** 押した版を先頭に、作成で一緒に取り込むもう片方の版を並べる(ペアが無い版種は 1 つだけ)。 */
function editionsOf(editionType: string): string[] {
  const other = EDITION_SYNC_PAIRS[editionType];
  return other === undefined ? [editionType] : [editionType, other];
}

/** local の Rep1 委託会社コード(略称 → コード)。検証用 DB(`Rep1_検証用.sql`)と同じ対応。 */
const LOCAL_REP1_COMPANY_CODES: Readonly<Record<string, string>> = { AM01: '00001', AM02: '00002' };
const rep1CodeOf = (abbr: string) => LOCAL_REP1_COMPANY_CODES[abbr] ?? abbr;

/** 編集タブ・比較・結合が扱うのは値入り HTML(基準日あり)だけ。テンプレートは作成タブで開く。 */
const filledMetas = () => allMetas().filter((m) => m.attributes.baseDate !== undefined);

/** 作業中か(同じ id の下書きか、承認前の生成物)。server の「下書きか pending/ がある」と同じ規則。 */
function inProgress(templateId: string): boolean {
  if (read<Record<string, TemplateDraft>>(K.drafts, {})[templateId]) return true;
  return allMetas().some((m) => m.id === templateId && m.updatedAt === null);
}

/** 同じ id の承認待ちの作成申請があるか(server の `hasPendingCreateReview` と同じ規則)。 */
function hasPendingCreateReview(templateId: string): boolean {
  const want = templateId.toLowerCase();
  return Object.values(read<Record<string, ReviewRequest>>(K.reviews, {})).some(
    (r) => r.status === 'pending' && r.origin === 'create' && r.templateId.toLowerCase() === want,
  );
}

/**
 * 確定内容の実反映(local 版)。承認ワークフローの `approveReview`(`reviewRepo.ts`)だけが
 * 呼ぶ内部経路で、Repository 契約には公開しない(確定保存は申請 → 承認の 2 段階ゲートに
 * 一本化。REST 側の対応物は server の `applyConfirmedWrite`)。
 */
export const confirmSaveLocal = (req: ConfirmSaveRequest, extra?: ConfirmSaveExtra) =>
  attempt(() =>
    // 全 write を一括コミットする: 途中失敗(例: quota)は触れた全キーを保存前状態へ
    // ロールバックし、ストアが half-published で残らないようにする。`notFound` ガードも
    // tx 内にあるため、meta 欠落時はその上の write も巻き戻る。
    tx(
      [
        K.htmlOverride,
        K.filledOverride,
        K.cssOverride,
        META_KEY,
        K.editHist,
        K.snapshots,
        K.instances,
        K.drafts,
        ...(extra?.keys ?? []),
      ],
      () => {
        const who = currentUser()?.displayName ?? '不明';
        const historyId = uid('eh');
        const timestamp = now(); // edit-history entry とその snapshot で共有する

        putContentOverrides(req);
        stampMeta(req.templateId, who);
        appendEditHistory(req, who, historyId, timestamp);
        freezeSnapshot(req, historyId, timestamp);
        putInstance(req, who);
        clearDraft(req.templateId);
        extra?.commit();

        const meta = allMetas().find((m) => m.id === req.templateId);
        if (!meta) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
        return delay(meta);
      },
    ),
  );

export const localTemplateRepo: TemplateRepository = {
  listCompanies: () =>
    attempt(() => {
      const byCode = new Map<string, string>();
      for (const f of Object.values(fundMaster)) byCode.set(f.company.code, f.company.name);
      return delay(
        [...byCode.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, name]) => ({
            companyCode: code,
            companyName: name,
            rep1CompanyCode: rep1CodeOf(code),
          })),
      );
    }),

  listFunds: (rep1CompanyCode: string) =>
    attempt(() =>
      delay(
        Object.entries(fundMaster)
          .filter(
            ([, f]) => rep1CodeOf(f.company.code).toLowerCase() === rep1CompanyCode.toLowerCase(),
          )
          .map(([fundCode, f]) => ({ fundCode, fundName: f.name }))
          .sort((a, b) => a.fundCode.localeCompare(b.fundCode)),
      ),
    ),

  getCreatableInfo: ({ companyCode, fundCode, editionType }) =>
    attempt(() => {
      // 作成は両版を 1 組で取り込むので、作成済み・作業中は両版のどちらかで決める(server と同じ。
      // 押した版を優先し、無ければもう片方の版)。
      const editions = editionsOf(editionType);
      const created = editions
        .map((e) => confirmedSkeleton(companyCode, fundCode, e))
        .find((m) => m !== undefined);
      const inProgressId = created
        ? undefined
        : editions
            .map((e) =>
              templateIdFromFileName(skeletonFileName({ companyCode, fundCode, editionType: e })),
            )
            .find((id) => inProgress(id));
      // シリーズはモック(`SERIES_FUND_CODES`)。コピー元は承認済みのテンプレートだけ(server と同じ)。
      const seriesFunds = SERIES_FUND_CODES.has(fundCode)
        ? [...SERIES_FUND_CODES]
            .filter((c) => c !== fundCode)
            .sort()
            .map((c) => ({
              fundCode: c,
              fundName: fundMaster[c]?.name ?? '',
              // 生成は両版のコピー元を要るので、両版がそろった候補だけ選べる(server と同じ)。
              hasTemplate: editions.every(
                (e) => confirmedSkeleton(companyCode, c, e) !== undefined,
              ),
            }))
        : [];
      return delay({
        created: created !== undefined,
        ...(created ? { templateId: created.id } : {}),
        ...(inProgressId === undefined ? {} : { inProgressId }),
        seriesFunds,
      });
    }),

  getDropdownOptions: (query: DropdownQuery, scope: DropdownScope) =>
    attempt(() => {
      // 比較・結合(published)は承認済みだけを扱う画面なので、候補も承認済みから作る。
      const metas = filledMetas().filter((m) => scope !== 'published' || m.status === 'published');
      // 各候補は「自分より上位の選択」だけで絞る(自分自身・下位は含めない)。そうしないと
      // 最下位の版種を選んだ後にその版種だけへ候補が潰れ、別の版種(例: 全体版)へ戻せない。
      const matchesUpper = (m: TemplateMeta, fields: (keyof TemplateAttributes)[]): boolean =>
        fields.every((f) => {
          const want = query[f];
          return !want || (m.attributes[f] ?? '').toLowerCase() === want.toLowerCase();
        });
      return delay({
        companyCodes: uniqSorted(metas.map((m) => m.attributes.companyCode)),
        fundCodes: uniqSorted(
          metas.filter((m) => matchesUpper(m, ['companyCode'])).map((m) => m.attributes.fundCode),
        ),
        baseDates: uniqSorted(
          metas
            .filter((m) => matchesUpper(m, ['companyCode', 'fundCode']))
            .flatMap((m) => m.attributes.baseDate ?? []),
        ),
        editionTypes: uniqSorted(
          metas
            .filter((m) => matchesUpper(m, ['companyCode', 'fundCode', 'baseDate']))
            .map((m) => m.attributes.editionType),
        ),
      });
    }),

  listTemplates: (query: DropdownQuery) =>
    attempt(() => delay(filledMetas().filter((m) => metaMatches(m, query)))),

  getTemplate: (id: string) =>
    attempt(() => {
      const meta = allMetas().find((m) => m.id === id);
      if (!meta) throw notFound(`テンプレートが見つかりません: ${id}`);
      const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
      const html = htmlOverride[id] ?? fixtureTemplates[meta.fileName] ?? '';
      const css = localCssOf(id);
      return delay({
        meta,
        html,
        css: css ?? '',
        filled: resolveFilled(id, meta.fileName),
        ...(css === undefined ? { cssMissing: true } : {}),
      });
    }),

  generate: (req: GenerateRequest) =>
    attempt(async () => {
      const user = currentUser();
      // テンプレートは会社・ファンド・版種に 1 つで、基準日を持たない。作成は交付版と全体版を
      // 1 組で取り込む(server の生成と同じ規則)。全部の版を調べてから書き、途中で失敗したら何も捨てない。
      const plans: {
        attrs: SkeletonAttributes;
        fileName: string;
        id: string;
        baseHtml: string;
        css: string;
      }[] = [];
      for (const editionType of editionsOf(req.editionType)) {
        const attrs: SkeletonAttributes = {
          companyCode: req.companyCode,
          fundCode: req.fundCode,
          editionType,
        };
        const fileName = skeletonFileName(attrs);
        const id = templateIdFromFileName(fileName);
        if (confirmedSkeleton(req.companyCode, req.fundCode, editionType)) {
          throw conflict('作成済みです。既存のテンプレートを開いてください');
        }
        if (hasPendingCreateReview(id)) {
          throw conflict('申請中です。承認か却下を待ってください');
        }
        if (req.replaceExisting !== true && inProgress(id)) {
          throw conflict('作成中のテンプレートがあります');
        }
        let baseHtml: string;
        let css: string;
        if (req.sourceFundCode) {
          const source = confirmedSkeleton(req.companyCode, req.sourceFundCode, editionType);
          if (!source)
            throw validation(`コピー元のテンプレートがありません: ${req.sourceFundCode}`);
          const baseRes = await localTemplateRepo.getTemplate(source.id);
          if (isErr(baseRes)) throw baseRes.error;
          baseHtml = baseRes.value.html;
          css = baseRes.value.css; // コピー元テンプレの CSS
        } else {
          baseHtml =
            fixtureTemplates[
              Object.keys(fixtureTemplates).find((f) =>
                f.startsWith(`${req.companyCode}_${req.fundCode}_`),
              ) ?? ''
            ] ?? defaultSkeleton();
          css = localCssOf(id) ?? ''; // 同じ名前の既存 CSS、無ければ空
        }
        // 償還ファンド指定時は特定パーツを償還用パーツへ置換(モック)。
        if (req.isRedemption) baseHtml = applyRedemptionMock(baseHtml);
        plans.push({ attrs, fileName, id, baseHtml, css });
      }
      // 生成できたので、前回の下書きを捨ててから置く(server と同じく失敗時は何も捨てない)。
      const htmlOverride = read<Record<string, string>>(K.htmlOverride, {});
      const createHist = read<CreateHistoryEntry[]>(K.createHist, []);
      for (const { attrs, id, baseHtml } of plans) {
        clearDraft(id);
        // editor で開けるよう draft override として永続化する。
        htmlOverride[id] = baseHtml;
        createHist.unshift({
          id: uid('ch'),
          attributes: attrs,
          user: user?.displayName ?? '不明',
          timestamp: now(),
          ...(req.sourceFundCode ? { sourceFundCode: req.sourceFundCode } : {}),
        });
      }
      write(K.htmlOverride, htmlOverride);
      write(K.createHist, createHist);
      // 返すのは押した版(先頭)。新規生成 skeleton には静的 fill が無い。editor が 1 つ描画する。
      const [pressed] = plans;
      const meta: TemplateMeta = {
        id: pressed.id,
        attributes: pressed.attrs,
        fileName: pressed.fileName,
        status: 'draft',
        updatedAt: null,
        updatedBy: null,
      };
      return delay({
        template: { meta, html: pressed.baseHtml, css: pressed.css, filled: '' },
        importedIds: plans.map((x) => x.id),
        skipped: [],
      });
    }),

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

  // パーツ別共通ダミー(`sampleCommon`)に funds.json の実名だけ被せて返す(local に合成の警告は無い)。
  // 版種・基準日(ファイル名由来)はテンプレを開く文脈で `applyTemplateAttributes` が上書きする。
  getSampleData: (templateId: string) =>
    attempt(() => {
      const fundCode = parseAnyTemplateFileName(`${templateId}.html`)?.fundCode ?? '';
      const f = fundMaster[fundCode];
      const master = f && {
        fundName: f.name,
        companyCode: f.company.code,
        companyName: f.company.name,
      };
      return delay({ sample: buildSampleData(sampleCommon, master, fundCode), warnings: [] });
    }),

  // 編集タブの値ファイル。server と同じく 4 区切りの ID だけを受け、無ければ found: false。
  getTemplateValues: (templateId: string) =>
    attempt(() => {
      assertTemplateId(templateId);
      const values = fixtureValues[`${templateId}.json`];
      return delay(values ? { found: true, values } : { found: false, values: {} });
    }),

  // ペア同期は server 側機構(承認直後に実行)のため local ではペアの有無だけを返す。
  // 競合は常に空(local に同期状態ファイルは存在しない)。
  getSyncStatus: (templateId: string) =>
    attempt(() => {
      const pairId = pairedTemplateId(templateId);
      return delay({
        pairTemplateId: pairId,
        pairExists: pairId !== null && allMetas().some((m) => m.id === pairId),
        conflicts: [],
        valueChecks: [],
        cssConflicts: [],
      });
    }),
};
