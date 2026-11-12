// =============================================================================
// TemplateRepository.ts — テンプレート集約ルート (探索/生成/下書き/確定/サンプル)
// =============================================================================
import type {
  CompanyOption,
  CreatableInfo,
  DropdownOptions,
  DropdownQuery,
  DropdownScope,
  FillResult,
  FundOption,
  GenerateRequest,
  GenerateResult,
  OfficialPdfStatus,
  PairSyncStatus,
  ReportStatus,
  SampleDataResult,
  SaveDraftRequest,
  Template,
  TemplateDraft,
  TemplateMeta,
  TemplateValues,
} from '../index.js';
import type { Result } from '../result.js';

/**
 * テンプレート集約ルート: 探索・生成・常時オンの下書き・確定ファイル・プレビュー用
 * サンプルデータを、同一のテンプレート identity と override ストアで束ねる。
 */
export interface TemplateRepository {
  /** 作成タブの委託会社(Rep1 のファンド属性)。`companyCode` はファイル名の会社コード(略称)。 */
  listCompanies(): Promise<Result<CompanyOption[]>>;
  /** 作成タブのファンド(Rep1 の委託会社コードで引く)。 */
  listFunds(rep1CompanyCode: string): Promise<Result<FundOption[]>>;
  /**
   * 作成タブ Step 2 の素: 版ごとの作成可否と、シリーズのコピー元候補(テンプレの有無付き)。
   * `editionType` を省けば両版の状態を返す。
   */
  getCreatableInfo(q: {
    companyCode: string;
    rep1CompanyCode: string;
    fundCode: string;
    editionType?: string;
  }): Promise<Result<CreatableInfo>>;
  /** 候補。出所は画面ごとに違う(edit / published。`DropdownScope` を参照)。 */
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
  /**
   * プレビュー文脈のサンプル。DB の共通サンプルに、テンプレート ID の会社・ファンドを Rep1 で引いた
   * 実名を被せて返す(3 区切り・4 区切りの ID を受ける)。`warnings` は合成の問題。
   */
  getSampleData(templateId: string): Promise<Result<SampleDataResult>>;
  /**
   * 編集タブの値ファイル(4 区切りの ID だけ)。ファイルが無いときはエラーにせず
   * `found: false` と空の `values` を返す(警告を出すかは呼び出し側が決める)。
   */
  getTemplateValues(templateId: string): Promise<Result<TemplateValues>>;
  /**
   * 交付版⇄全体版 ペア同期の現況(未解決競合の一覧)。編集画面を開いた時のバナー表示に使う。
   * ペア対象外の版種でもエラーにせず `pairTemplateId: null` を返す(呼び出し側の分岐を単純に)。
   */
  getSyncStatus(templateId: string): Promise<Result<PairSyncStatus>>;
  /** create_report 連携が有効か。画面が入口(値入り HTML の作成・PDF)を出すかの判定に使う。 */
  getReportStatus(): Promise<Result<ReportStatus>>;
  /** 4 区切りの ID の値入り HTML を create_report で作る。既にあれば `created: false`。 */
  fillTemplate(id: string): Promise<Result<FillResult>>;
  /** 組み立て済みの文書 `html` を create_report 経由で PDF にする。失敗は `code` を保つ。 */
  buildReportPdf(id: string, html: string): Promise<Result<Blob>>;
  /** 値入り HTML の正式 PDF の組版状態。 */
  officialPdfStatus(id: string): Promise<Result<OfficialPdfStatus>>;
  /** 正式 PDF の作り直しを積む(承認権限)。積んだ直後の状態を返す。 */
  rebuildOfficialPdf(id: string): Promise<Result<OfficialPdfStatus>>;
}
