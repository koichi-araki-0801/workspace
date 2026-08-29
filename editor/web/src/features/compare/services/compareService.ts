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
import { renderJinjaIsolated } from '@/lib/renderHostClient';

/** 版レンダリング失敗時に表示する文言(原因は別途ログに記録する)。 */
export const COMPARE_RENDER_ERROR =
  'バージョンの表示に失敗しました。時間をおいて再度お試しください。';

// 「現行版」(現在のテンプレート = 最新のライブ本文)を表す合成版。確定版(snapshot)が
// 1 件も無いテンプレートでも、現行版を 1 版として比較できるようにする。`historyId` は
// 接頭辞で識別し、`renderVersionHtml` で snapshot 経路と分岐する。
const BASELINE_PREFIX = 'baseline:';
const baselineHistoryId = (templateId: string) => `${BASELINE_PREFIX}${templateId}`;
const baselineTemplateId = (historyId: string) => historyId.slice(BASELINE_PREFIX.length);
const isBaselineId = (historyId: string) => historyId.startsWith(BASELINE_PREFIX);

/** 現在のテンプレート(最新のライブ本文)を表す合成版メタ。`timestamp` を持たないので
 *  UI 側は `user`(=現行版)を表示する。 */
const baselineVersion = (templateId: string): TemplateVersionMeta => ({
  historyId: baselineHistoryId(templateId),
  templateId,
  timestamp: '',
  user: '現行版',
  summary: '現行版（現在のテンプレート）',
});

/** 候補テーブル用に、ヒットしたテンプレートとその選択可能な版をまとめた型。 */
export interface CompareCandidate {
  meta: TemplateMeta;
  /** 選択可能な版 = 先頭に現行版(最新のライブ本文) 1 + 確定版(snapshot, 新しい順)。現行版が
   *  常に 1 つあるため、何も編集していないテンプレートでも 1 版以上になり比較対象に選べる。 */
  versions: TemplateVersionMeta[];
  /** `versions.length`。版数列の表示と既存利用の互換のために保持する。 */
  versionCount: number;
}

/** テーブルを「版ごとの行」に平坦化したときの 1 行(テンプレート × 版)。 */
export interface CompareVersionRow {
  meta: TemplateMeta;
  version: TemplateVersionMeta;
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
  /**
   * 1 版の snapshot を HTML へレンダリングする(クライアント側、サーバ往復なし)。
   * `templateId` はどのテンプレの版かの指定で、1 コミットが複数テンプレを含む版で要る。
   */
  renderVersionHtml(historyId: string, templateId?: string): Promise<Result<RenderedVersion>>;
  /**
   * 任意のテンプレ本文(html/css)を、現行版/snapshot と同一の描画経路(`getSampleData` +
   * `renderJinjaIsolated`)でレンダリングする。承認画面が申請内容を現行版と同じ土俵で diff
   * するために使う(見せかけ差分を出さないよう、版種を被せない素の sample を現行版と共有する)。
   */
  renderTemplateBody(html: string, css: string, fundCode: string): Promise<Result<RenderedVersion>>;
}

export function createCompareService(
  templates: TemplateRepository,
  history: HistoryRepository,
): CompareService {
  // snapshot 群(新しい順)の先頭に「現行版」(最新のライブ本文)を必ず 1 件足す。現行版が
  // 最新なので一覧の先頭に来る。確定版が無いテンプレートでは、これが唯一の選択肢として
  // 現れる。listVersions/listCandidates 共用。
  async function versionsWithBaseline(templateId: string): Promise<Result<TemplateVersionMeta[]>> {
    const res = await history.listVersions(templateId);
    if (isErr(res)) return res;
    return ok([baselineVersion(templateId), ...res.value]);
  }

  return {
    listTemplates: (query) => templates.listTemplates(query),

    listVersions: (templateId) => versionsWithBaseline(templateId),

    async listCandidates(query) {
      const metasRes = await templates.listTemplates(query);
      if (isErr(metasRes)) return metasRes;
      const candidates: CompareCandidate[] = [];
      // 比較は確定済み同士で行う。`listTemplates` は編集タブが生成直後のテンプレへ到達
      // できるよう pending(`status:'draft'`)も返すため、ここで承認済みだけへ絞る。
      for (const meta of metasRes.value.filter((m) => m.status === 'published')) {
        // 各候補に版リスト(現行版込み)を持たせ、テーブル側で版ごとの行へ平坦化できるようにする。
        // 確定版が無くても原本「現行版」が 1 件あるので、未編集の配信テンプレート
        // (例: 高金利ソブリン)も比較対象に出せる(版リスト側は status で絞らない)。
        const versRes = await versionsWithBaseline(meta.id);
        if (isErr(versRes)) return versRes;
        candidates.push({ meta, versions: versRes.value, versionCount: versRes.value.length });
      }
      return ok(candidates);
    },

    // ここが返す HTML は比較画面・承認画面の iframe へそのまま入る。**能動コンテンツは
    // 除去しない。** テンプレの JavaScript は開発者が生成時に埋め込む正当なコンテンツで、
    // 承認者は「JS が効いた実行結果」を見て承認する — 落とすと、承認者が承認していない
    // 見た目が確定してしまう。
    //
    // 代わりの防壁は 2 つ: ① 表示先の iframe が `sandbox="allow-scripts"`(same-origin
    // なし)= opaque origin で、親アプリの DOM にも Cookie にも到達できない
    // (`iframeSandbox.guard.test.ts` が機械検証)。② 実行コード面は生成時から不変である
    // ことをサーバが照合する(`server/src/security/templateScripts.ts`)。
    // 差分計算が読む経路は `DOMParser.parseFromString(_, 'text/html')` の inert document
    // なので、ここで script が実行されることはない。
    //
    // **Jinja のコンパイル自体もこのオリジンでは行わない。** nunjucks はサンドボックスでなく
    // コンパイラで、`{{ range.constructor("…")() }}` は `new Function` へ到達する。承認者の
    // ページで走らせると承認者のセッションのまま承認 API を叩けてしまうため、
    // 描画は opaque オリジンの iframe(`lib/renderHostClient.ts`)へ委ねる。
    async renderVersionHtml(historyId, templateId) {
      // 「現行版」は snapshot を持たない。原本(現在のテンプレート HTML)をサンプル値で
      // 描画し、確定版と同じ「値埋め込み後」HTML を返す。描画経路を snapshot と一致させ、
      // 原本 <-> 確定版の比較で見せかけの差分が出ないようにする。
      if (isBaselineId(historyId)) {
        const tplRes = await templates.getTemplate(baselineTemplateId(historyId));
        if (isErr(tplRes)) return tplRes;
        const tpl = tplRes.value;
        const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
        if (isErr(sampleRes)) return sampleRes;
        const rendered = await renderJinjaIsolated(tpl.html, sampleRes.value);
        if (rendered.error) return err(conflict(COMPARE_RENDER_ERROR, { cause: rendered.error }));
        return ok({ html: rendered.html, css: tpl.css });
      }

      const snapRes = await history.getSnapshot(historyId, templateId);
      if (isErr(snapRes)) return snapRes;
      const snap = snapRes.value;

      const sampleRes = await templates.getSampleData(snap.fundCode);
      if (isErr(sampleRes)) return sampleRes;

      // プレビュー画面と同じレンダリング経路だが、処理はブラウザ内で完結させる。
      // block diff がこの HTML を直接パースするため、PDF 化やサーバ往復は不要。
      const rendered = await renderJinjaIsolated(snap.html, sampleRes.value);
      if (rendered.error) return err(conflict(COMPARE_RENDER_ERROR, { cause: rendered.error }));
      return ok({ html: rendered.html, css: snap.css });
    },

    async renderTemplateBody(html, css, fundCode) {
      const sampleRes = await templates.getSampleData(fundCode);
      if (isErr(sampleRes)) return sampleRes;
      // baseline 経路と同じく素の sample で描画する(版種を被せない)。現行版と土俵を揃える。
      const rendered = await renderJinjaIsolated(html, sampleRes.value);
      if (rendered.error) return err(conflict(COMPARE_RENDER_ERROR, { cause: rendered.error }));
      return ok({ html: rendered.html, css });
    },
  };
}

export const useCompareService = (): CompareService =>
  createCompareService(useTemplateRepo(), useHistoryRepo());
