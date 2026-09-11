// =============================================================================
// templateRepo.ts — テンプレートの一覧/取得/生成/保存の REST 実装
// =============================================================================
import {
  apiPaths,
  buildPath,
  type DropdownOptions,
  type DropdownQuery,
  type FundResolution,
  type GenerateRequest,
  type GenerateResult,
  isOk,
  map,
  ok,
  type PairSyncStatus,
  type SampleData,
  type SaveDraftRequest,
  type Template,
  type TemplateDraft,
  type TemplateMeta,
  type TemplateRepository,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

// ファンド名・会社名(`getSampleData`)は作成タブの表示にしか使わず、同じタブの間に何度も
// 変わらない。sessionStorage に持ち、タブを閉じれば消える(端末に残さない)。
const SAMPLE_CACHE_PREFIX = 'editor:sample:';
const sampleCacheKey = (fundCode: string) => `${SAMPLE_CACHE_PREFIX}${fundCode}`;

function readSampleCache(fundCode: string): SampleData | null {
  try {
    const raw = sessionStorage.getItem(sampleCacheKey(fundCode));
    return raw ? (JSON.parse(raw) as SampleData) : null;
  } catch {
    return null;
  }
}

function writeSampleCache(fundCode: string, data: SampleData): void {
  try {
    sessionStorage.setItem(sampleCacheKey(fundCode), JSON.stringify(data));
  } catch {
    /* 容量超過・無効化時は保存しない(次回も取得するだけ) */
  }
}

/** ログアウト時に呼ぶ。次の利用者に前の利用者が見たファンド名を残さない。 */
export function clearSampleDataCache(): void {
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(SAMPLE_CACHE_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* sessionStorage が無い環境では何もしない */
  }
}

/** シリーズ(sproc `系列`)の問い合わせ。`resolveFund` と `listSeriesFunds` で共用。 */
const seriesFetch = (companyCode: string, fundCode: string, editionType: string) =>
  attemptRest(() =>
    apiFetch<TemplateMeta[]>(apiPaths.templatesSeries, {
      query: { companyCode, fundCode, editionType },
    }),
  );

export const restTemplateRepo: TemplateRepository = {
  getDropdownOptions: (query: DropdownQuery) =>
    attemptRest(() =>
      apiFetch<DropdownOptions>(apiPaths.templatesOptions, {
        query: query as Record<string, string | undefined>,
      }),
    ),

  listTemplates: (query: DropdownQuery) =>
    attemptRest(() =>
      apiFetch<TemplateMeta[]>(apiPaths.templates, {
        query: query as Record<string, string | undefined>,
      }),
    ),

  getTemplate: (id: string) =>
    attemptRest(() => apiFetch<Template>(buildPath(apiPaths.templateById, { id }))),

  generate: (req: GenerateRequest) =>
    attemptRest(() => apiFetch<GenerateResult>(apiPaths.generate, { method: 'POST', body: req })),

  // 属性解決: シリーズの sproc 結果に自分以外のメンバーが居ればシリーズファンド。
  resolveFund: async (companyCode: string, fundCode: string, editionType: string) =>
    map(
      await seriesFetch(companyCode, fundCode, editionType),
      (rows): FundResolution => ({
        isSeriesFund: rows.some((m) => m.attributes.fundCode !== fundCode),
      }),
    ),

  listSeriesFunds: (companyCode: string, fundCode: string, editionType: string) =>
    seriesFetch(companyCode, fundCode, editionType),

  saveDraft: (req: SaveDraftRequest) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.templateDraft, { id: req.templateId }), {
        method: 'PUT',
        body: req,
      }),
    ),

  getDraft: (templateId: string) =>
    attemptRest(() =>
      apiFetch<TemplateDraft | null>(buildPath(apiPaths.templateDraft, { id: templateId })),
    ),

  discardDraft: (templateId: string) =>
    attemptRest(() =>
      apiFetch<void>(buildPath(apiPaths.templateDraft, { id: templateId }), { method: 'DELETE' }),
    ),

  getSampleData: async (fundCode: string) => {
    const cached = readSampleCache(fundCode);
    if (cached) return ok(cached);
    const res = await attemptRest(() =>
      apiFetch<SampleData>(buildPath(apiPaths.fundSampleData, { fundCode })),
    );
    if (isOk(res)) writeSampleCache(fundCode, res.value);
    return res;
  },

  getSyncStatus: (templateId: string) =>
    attemptRest(() =>
      apiFetch<PairSyncStatus>(buildPath(apiPaths.templateSyncStatus, { id: templateId })),
    ),
};
