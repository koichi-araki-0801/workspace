// =============================================================================
// templateRepo.ts — テンプレートの一覧/取得/生成/保存の REST 実装
// =============================================================================
import {
  apiPaths,
  buildPath,
  type CompanyOption,
  type CreatableInfo,
  type DropdownOptions,
  type DropdownQuery,
  type DropdownScope,
  type FundOption,
  type GenerateRequest,
  type GenerateResult,
  isOk,
  ok,
  type PairSyncStatus,
  type SampleDataResult,
  type SaveDraftRequest,
  type Template,
  type TemplateDraft,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateValues,
} from '@editor/shared';
import { apiFetch, attemptRest } from './http';

// サンプル(`getSampleData`)は共通サンプルとファンド名・会社名で、同じタブの間に何度も変わらない。
// テンプレート ID ごとに sessionStorage に持ち、タブを閉じれば消える(端末に残さない)。
const SAMPLE_CACHE_PREFIX = 'editor:sample:';
const sampleCacheKey = (templateId: string) => `${SAMPLE_CACHE_PREFIX}${templateId}`;

function isSampleDataResult(v: unknown): v is SampleDataResult {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const { sample, warnings } = v as Record<string, unknown>;
  return (
    typeof sample === 'object' &&
    sample !== null &&
    !Array.isArray(sample) &&
    Array.isArray(warnings) &&
    warnings.every((w) => typeof w === 'string')
  );
}

function readSampleCache(templateId: string): SampleDataResult | null {
  try {
    const raw = sessionStorage.getItem(sampleCacheKey(templateId));
    if (!raw) return null;
    // sessionStorage は他スクリプト・拡張機能からも書き換えられうる外部入力。`{ sample, warnings }` の
    // 形でない値(壊れた JSON・配列・旧形式のサンプル本体)を扱うと呼び出し側が形の合わない値を掴む。
    const parsed: unknown = JSON.parse(raw);
    return isSampleDataResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSampleCache(templateId: string, data: SampleDataResult): void {
  try {
    sessionStorage.setItem(sampleCacheKey(templateId), JSON.stringify(data));
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

export const restTemplateRepo: TemplateRepository = {
  listCompanies: () => attemptRest(() => apiFetch<CompanyOption[]>(apiPaths.templatesCompanies)),

  listFunds: (rep1CompanyCode: string) =>
    attemptRest(() =>
      apiFetch<FundOption[]>(apiPaths.templatesFunds, { query: { rep1CompanyCode } }),
    ),

  getCreatableInfo: (q) =>
    attemptRest(() => apiFetch<CreatableInfo>(apiPaths.templatesCreatable, { query: { ...q } })),

  getDropdownOptions: (query: DropdownQuery, scope: DropdownScope) =>
    attemptRest(() =>
      apiFetch<DropdownOptions>(apiPaths.templatesOptions, {
        query: { ...query, scope } as Record<string, string | undefined>,
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

  getSampleData: async (templateId: string) => {
    const cached = readSampleCache(templateId);
    if (cached) return ok(cached);
    const res = await attemptRest(() =>
      apiFetch<SampleDataResult>(buildPath(apiPaths.templateSampleData, { id: templateId })),
    );
    if (isOk(res)) writeSampleCache(templateId, res.value);
    return res;
  },

  getTemplateValues: (templateId: string) =>
    attemptRest(() =>
      apiFetch<TemplateValues>(buildPath(apiPaths.templateValues, { id: templateId })),
    ),

  getSyncStatus: (templateId: string) =>
    attemptRest(() =>
      apiFetch<PairSyncStatus>(buildPath(apiPaths.templateSyncStatus, { id: templateId })),
    ),
};
