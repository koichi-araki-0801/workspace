// =============================================================================
// templateCreationService.ts — 属性検証つきテンプレ生成とシリーズ関連の問い合わせ
// =============================================================================
import {
  type CompanyOption,
  type CreatableInfo,
  err,
  type FundOption,
  type GenerateRequest,
  isOk,
  map,
  type Result,
  type TemplateMeta,
  type TemplateRepository,
  validation,
} from '@editor/shared';
import { useTemplateRepo } from '@/api/repositories';
import { draftOwner } from '@/lib/draftOwner';
import { useEditorSessionStore } from '@/stores/editorSession';

/** テンプレ作成に必要な属性が不足しているときに表示するメッセージ。 */
export const SELECT_ALL_MSG = '委託会社・ファンド・版種を選択してください';

interface TemplateCreationService {
  /** 作成タブの委託会社(Rep1)。 */
  listCompanies(): Promise<Result<CompanyOption[]>>;
  /** 作成タブのファンド(Rep1 の委託会社コードで引く)。 */
  listFunds(rep1CompanyCode: string): Promise<Result<FundOption[]>>;
  /** 作成済みかとシリーズのコピー元候補。 */
  getCreatableInfo(
    q: Parameters<TemplateRepository['getCreatableInfo']>[0],
  ): Promise<Result<CreatableInfo>>;
  /** 属性を検証してから生成する。成功時は新規テンプレの meta を返す。 */
  create(req: GenerateRequest): Promise<Result<TemplateMeta>>;
}

/**
 * 生成に成功した id について、同じタブに残る編集状態を捨てる。作り直したテンプレートを開いたとき、
 * 前の生成物の Undo(とその永続ミラー)が残っていると 1 回の Undo で捨てたはずの本文が戻り、
 * autosave がそれを下書きとして書き戻す。下書きの持ち主の記録も前の作業のものなので消す。
 */
export function forgetLocalEditState(templateId: string): void {
  useEditorSessionStore().clear(templateId);
  draftOwner.release(templateId);
}

export function createTemplateCreationService(
  repo: TemplateRepository,
  forgetEditState: (templateId: string) => void = () => {},
): TemplateCreationService {
  return {
    async create(req) {
      if (!req.companyCode || !req.fundCode || !req.editionType) {
        return err(validation(SELECT_ALL_MSG));
      }
      const res = await repo.generate(req);
      if (isOk(res)) forgetEditState(res.value.template.meta.id);
      return map(res, (r) => r.template.meta);
    },
    listCompanies: () => repo.listCompanies(),
    listFunds: (rep1CompanyCode) => repo.listFunds(rep1CompanyCode),
    getCreatableInfo: (q) => repo.getCreatableInfo(q),
  };
}

// ストアは生成に成功したときに初めて引く(`forgetLocalEditState` の中)。setup の時点で引くと、
// Pinia を持たない部品のテストまで Pinia を要求する。
export const useTemplateCreationService = (): TemplateCreationService =>
  createTemplateCreationService(useTemplateRepo(), forgetLocalEditState);
