import {
  err,
  type FundResolution,
  type GenerateRequest,
  map,
  type Result,
  type TemplateMeta,
  type TemplateRepository,
  validation,
} from '@editor/shared';
import { useTemplateRepo } from '@/api/repositories';

/** Shown when the attributes needed to create a template are incomplete. */
export const SELECT_ALL_MSG = '委託会社・ファンド・版種を選択してください';

export interface TemplateCreationService {
  /** Validate the attributes, then generate; resolves to the new template's meta. */
  create(req: GenerateRequest): Promise<Result<TemplateMeta>>;
  /** 属性解決: シリーズファンド判定など。 */
  resolveFund(
    companyCode: string,
    fundCode: string,
    editionType: string,
  ): Promise<Result<FundResolution>>;
  listSeriesFunds(
    companyCode: string,
    fundCode: string,
    editionType: string,
  ): Promise<Result<TemplateMeta[]>>;
}

export function createTemplateCreationService(repo: TemplateRepository): TemplateCreationService {
  return {
    async create(req) {
      if (!req.companyCode || !req.fundCode || !req.editionType) {
        return err(validation(SELECT_ALL_MSG));
      }
      return map(await repo.generate(req), (r) => r.template.meta);
    },
    resolveFund: (companyCode, fundCode, editionType) =>
      repo.resolveFund(companyCode, fundCode, editionType),
    listSeriesFunds: (companyCode, fundCode, editionType) =>
      repo.listSeriesFunds(companyCode, fundCode, editionType),
  };
}

export const useTemplateCreationService = (): TemplateCreationService =>
  createTemplateCreationService(useTemplateRepo());
