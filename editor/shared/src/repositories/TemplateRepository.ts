// =============================================================================
// TemplateRepository.ts — テンプレート集約ルート (探索/生成/下書き/確定/サンプル)
// =============================================================================
import type {
  CompanyOption,
  CreatableInfo,
  DropdownOptions,
  DropdownQuery,
  DropdownScope,
  FundOption,
  GenerateRequest,
  GenerateResult,
  PairSyncStatus,
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
  /** 候補。出所は画面ごとに違う(edit / published / create。`DropdownScope` を参照)。 */
  /** 作成タブの委託会社(Rep1 のファンド属性)。`companyCode` はファイル名の会社コード(略称)。 */
  listCompanies(): Promise<Result<CompanyOption[]>>;
  /** 作成タブのファンド(Rep1 の委託会社コードで引く)。 */
  listFunds(rep1CompanyCode: string): Promise<Result<FundOption[]>>;
  /** 作成タブ Step 2 の素: 作成済みか、シリーズのコピー元候補(テンプレの有無付き)。 */
  getCreatableInfo(q: {
    companyCode: string;
    rep1CompanyCode: string;
    fundCode: string;
    editionType: string;
  }): Promise<Result<CreatableInfo>>;
  getDropdownOptions(query: DropdownQuery, scope: DropdownScope): Promise<Result<DropdownOptions>>;
  listTemplates(query: DropdownQuery): Promise<Result<TemplateMeta[]>>;
  getTemplate(id: string): Promise<Result<Template>>;
  generate(req: GenerateRequest): Promise<Result<GenerateResult>>;
  saveDraft(req: SaveDraftRequest): Promise<Result<void>>;
  getDraft(templateId: string): Promise<Result<TemplateDraft | null>>;
  /**
   * 確定保存せずメニューへ戻った際に、未確定の下書きを破棄する。冪等(無ければ no-op)。
   * 確定保存(承認ワークフローの実反映)は下書きを自動クリアするため、こちらは「破棄」専用。
   */
  discardDraft(templateId: string): Promise<Result<void>>;
  getSampleData(fundCode: string): Promise<Result<SampleData>>;
  /**
   * 交付版⇄全体版 ペア同期の現況(未解決競合の一覧)。編集画面を開いた時のバナー表示に使う。
   * ペア対象外の版種でもエラーにせず `pairTemplateId: null` を返す(呼び出し側の分岐を単純に)。
   */
  getSyncStatus(templateId: string): Promise<Result<PairSyncStatus>>;
}
