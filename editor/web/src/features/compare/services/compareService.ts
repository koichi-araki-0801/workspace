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

/** 候補テーブル用に、ヒットしたテンプレートと確定版数をまとめた型。 */
export interface CompareCandidate {
  meta: TemplateMeta;
  /** 確定版(snapshot)の数。比較には 2 版以上が必要。 */
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
    listVersions: (templateId) => history.listVersions(templateId),

    async listCandidates(query) {
      const metasRes = await templates.listTemplates(query);
      if (isErr(metasRes)) return metasRes;
      const candidates: CompareCandidate[] = [];
      for (const meta of metasRes.value) {
        if (meta.status !== 'published') continue; // 確定版のみを比較候補にする
        const versRes = await history.listVersions(meta.id);
        if (isErr(versRes)) return versRes;
        candidates.push({ meta, versionCount: versRes.value.length });
      }
      return ok(candidates);
    },

    async renderVersionHtml(historyId) {
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
