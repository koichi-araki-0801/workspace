// =============================================================================
// TemplateRepository.ts — テンプレート集約ルート (探索/生成/下書き/確定/サンプル)
// =============================================================================
import type {
  ConfirmSaveRequest,
  DropdownOptions,
  DropdownQuery,
  FundResolution,
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
 * テンプレート集約ルート: 探索・生成・常時オンの下書き・確定ファイル・プレビュー用
 * サンプルデータを、同一のテンプレート identity と override ストアで束ねる。
 */
export interface TemplateRepository {
  getDropdownOptions(query: DropdownQuery): Promise<Result<DropdownOptions>>;
  listTemplates(query: DropdownQuery): Promise<Result<TemplateMeta[]>>;
  getTemplate(id: string): Promise<Result<Template>>;
  generate(req: GenerateRequest): Promise<Result<GenerateResult>>;
  /**
   * 属性解決: 選択中の属性からファンドの性質（シリーズファンドか等）を判定する。
   * 作成画面で「シリーズから作成」を出すかの判断に使う。
   */
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
  saveDraft(req: SaveDraftRequest): Promise<Result<void>>;
  getDraft(templateId: string): Promise<Result<TemplateDraft | null>>;
  /**
   * 確定保存せずメニューへ戻った際に、未確定の下書きを破棄する。冪等(無ければ no-op)。
   * 確定保存は `confirmSave` 内で下書きを自動クリアするため、こちらは「破棄」専用。
   */
  discardDraft(templateId: string): Promise<Result<void>>;
  confirmSave(req: ConfirmSaveRequest): Promise<Result<TemplateMeta>>;
  getSampleData(fundCode: string): Promise<Result<SampleData>>;
}
