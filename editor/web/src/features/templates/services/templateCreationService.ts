// =============================================================================
// templateCreationService.ts — 属性検証つきテンプレ生成とシリーズ関連の問い合わせ
// =============================================================================
import {
  type CompanyOption,
  type CreatableInfo,
  err,
  type FundOption,
  type GenerateRequest,
  map,
  type Result,
  type TemplateMeta,
  type TemplateRepository,
  validation,
} from '@editor/shared';
import { useTemplateRepo } from '@/api/repositories';

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

export function createTemplateCreationService(repo: TemplateRepository): TemplateCreationService {
  return {
    async create(req) {
      if (!req.companyCode || !req.fundCode || !req.editionType) {
        return err(validation(SELECT_ALL_MSG));
      }
      return map(await repo.generate(req), (r) => r.template.meta);
    },
    listCompanies: () => repo.listCompanies(),
    listFunds: (rep1CompanyCode) => repo.listFunds(rep1CompanyCode),
    getCreatableInfo: (q) => repo.getCreatableInfo(q),
  };
}

export const useTemplateCreationService = (): TemplateCreationService =>
  createTemplateCreationService(useTemplateRepo());
