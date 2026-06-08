import type {
  ConfirmSaveRequest,
  DropdownOptions,
  DropdownQuery,
  GenerateRequest,
  GenerateResult,
  SampleData,
  SaveDraftRequest,
  Template,
  TemplateDraft,
  TemplateMeta,
} from '../index.js';
import type { Result } from '../result.js';

/**
 * Template aggregate root: discovery, generation, the always-on draft, the
 * confirmed file, and the preview sample data — all keyed by the same template
 * identity and override store.
 */
export interface TemplateRepository {
  getDropdownOptions(query: DropdownQuery): Promise<Result<DropdownOptions>>;
  listTemplates(query: DropdownQuery): Promise<Result<TemplateMeta[]>>;
  getTemplate(id: string): Promise<Result<Template>>;
  generate(req: GenerateRequest): Promise<Result<GenerateResult>>;
  listSeriesFunds(
    companyCode: string,
    fundCode: string,
    editionType: string,
  ): Promise<Result<TemplateMeta[]>>;
  saveDraft(req: SaveDraftRequest): Promise<Result<void>>;
  getDraft(templateId: string): Promise<Result<TemplateDraft | null>>;
  confirmSave(req: ConfirmSaveRequest): Promise<Result<TemplateMeta>>;
  getSampleData(fundCode: string): Promise<Result<SampleData>>;
}
