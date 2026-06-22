// =============================================================================
// compareService.ts — 版比較のデータ取得とクライアント側 HTML レンダリング
// =============================================================================
import {
  conflict,
  type DropdownQuery,
  err,
  type HistoryRepository,
  isErr,
  ok,
  type Result,
  type TemplateMeta,
  type TemplateRepository,
  type TemplateVersionMeta,
} from '@editor/shared';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { renderJinja } from '@/lib/nunjucksRender';

/** 版レンダリング失敗時に表示する文言(原因は別途ログに記録する)。 */
export const COMPARE_RENDER_ERROR =
  'バージョンの表示に失敗しました。時間をおいて再度お試しください。';

// 「現行版」(配信時点・編集前の原本)を表す合成版。確定版(snapshot)が 1 件も無い
// テンプレートでも、原本を 1 版として比較できるようにする。`historyId` は接頭辞で識別し、
// `renderVersionHtml` で snapshot 経路と分岐する。
const BASELINE_PREFIX = 'baseline:';
const baselineHistoryId = (templateId: string) => `${BASELINE_PREFIX}${templateId}`;
const baselineTemplateId = (historyId: string) => historyId.slice(BASELINE_PREFIX.length);
const isBaselineId = (historyId: string) => historyId.startsWith(BASELINE_PREFIX);

/** 原本を表す合成版メタ。`timestamp` を持たないので UI 側は `user`(=現行版)を表示する。 */
const baselineVersion = (templateId: string): TemplateVersionMeta => ({
  historyId: baselineHistoryId(templateId),
  templateId,
  timestamp: '',
  user: '現行版',
  summary: '現行版（配信時点・編集前）',
});

/** 候補テーブル用に、ヒットしたテンプレートと確定版数をまとめた型。 */
export interface CompareCandidate {
  meta: TemplateMeta;
  /** 選択可能な版数 = 確定版(snapshot)数 + 原本「現行版」1。現行版が常に 1 つあるため、
   *  何も編集していないテンプレートでも 1 版以上になり比較対象として選べる。 */
  versionCount: number;
}

/** 左右並列の block diff 用に、1 版を HTML へレンダリングした結果。 */
export interface RenderedVersion {
  /** 完全な HTML ドキュメント(nunjucks 適用済みの snapshot)。 */
  html: string;
  /** プレビュー `iframe` 用の、版ごとのファンド別 CSS。 */
  css: string;
}

export interface CompareService {
  /** cascading-dropdown クエリにヒットするテンプレート一覧(比較対象の選択用)。 */
  listTemplates(query: DropdownQuery): Promise<Result<TemplateMeta[]>>;
  /** ヒットしたテンプレートに確定版数を付与した候補一覧。 */
  listCandidates(query: DropdownQuery): Promise<Result<CompareCandidate[]>>;
  /** テンプレートの確定版(snapshot 付き)を新しい順で返す。 */
  listVersions(templateId: string): Promise<Result<TemplateVersionMeta[]>>;
  /** 1 版の snapshot を HTML へレンダリングする(クライアント側、サーバ往復なし)。 */
  renderVersionHtml(historyId: string): Promise<Result<RenderedVersion>>;
}

export function createCompareService(
  templates: TemplateRepository,
  history: HistoryRepository,
): CompareService {
  return {
    listTemplates: (query) => templates.listTemplates(query),

    async listVersions(templateId) {
      const res = await history.listVersions(templateId);
      if (isErr(res)) return res;
      // snapshot 群(新しい順)の末尾に原本「現行版」を必ず 1 件足す。確定版が無い
      // テンプレートでは、これが唯一の選択肢として現れる。
      return ok([...res.value, baselineVersion(templateId)]);
    },

    async listCandidates(query) {
      const metasRes = await templates.listTemplates(query);
      if (isErr(metasRes)) return metasRes;
      const candidates: CompareCandidate[] = [];
      for (const meta of metasRes.value) {
        const versRes = await history.listVersions(meta.id);
        if (isErr(versRes)) return versRes;
        // 確定版が無くても原本を「現行版」として +1 する。これにより未編集の配信
        // テンプレート(例: 高金利ソブリン)も比較対象に出せる。status 絞り込みは廃止
        // (「配信済み = 確定版あり」前提を外し、原本そのものを比較対象にする)。
        candidates.push({ meta, versionCount: versRes.value.length + 1 });
      }
      return ok(candidates);
    },

    async renderVersionHtml(historyId) {
      // 「現行版」は snapshot を持たない。原本(現在のテンプレート HTML)をサンプル値で
      // 描画し、確定版と同じ「値埋め込み後」HTML を返す。描画経路を snapshot と一致させ、
      // 原本 <-> 確定版の比較で見せかけの差分が出ないようにする。
      if (isBaselineId(historyId)) {
        const tplRes = await templates.getTemplate(baselineTemplateId(historyId));
        if (isErr(tplRes)) return tplRes;
        const tpl = tplRes.value;
        const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
        if (isErr(sampleRes)) return sampleRes;
        const rendered = renderJinja(tpl.html, sampleRes.value);
        if (rendered.error) return err(conflict(COMPARE_RENDER_ERROR, { cause: rendered.error }));
        return ok({ html: rendered.html, css: tpl.css });
      }

      const snapRes = await history.getSnapshot(historyId);
      if (isErr(snapRes)) return snapRes;
      const snap = snapRes.value;

      const sampleRes = await templates.getSampleData(snap.fundCode);
      if (isErr(sampleRes)) return sampleRes;

      // プレビュー画面と同じレンダリング経路だが、処理はブラウザ内で完結させる。
      // block diff がこの HTML を直接パースするため、PDF 化やサーバ往復は不要。
      const rendered = renderJinja(snap.html, sampleRes.value);
      if (rendered.error) return err(conflict(COMPARE_RENDER_ERROR, { cause: rendered.error }));
      return ok({ html: rendered.html, css: snap.css });
    },
  };
}

export const useCompareService = (): CompareService =>
  createCompareService(useTemplateRepo(), useHistoryRepo());
