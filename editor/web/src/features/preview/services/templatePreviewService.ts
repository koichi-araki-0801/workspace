// =============================================================================
// templatePreviewService.ts — プレビュー画面のロード/PDF 出力サービス
// =============================================================================
import {
  apiPaths,
  applyTemplateAttributes,
  conflict,
  err,
  type HistoryRepository,
  isErr,
  ok,
  type Result,
  type SampleData,
  type Template,
  type TemplateRepository,
  unexpected,
  validation,
} from '@editor/shared';
import { useHistoryRepo, useTemplateRepo } from '@/api/repositories';
import { apiUrl } from '@/api/rest/http';
import { logError } from '@/lib/appError';
import { type DraftOwner, draftOwner } from '@/lib/draftOwner';
import { formatCss } from '@/lib/formatOutput';
import { assemblePreviewDocument } from '@/lib/nunjucksRender';
import { PDF_ERROR_MSG, renderPdfDocument } from '@/lib/pdfDocument';
import { renderJinjaIsolated } from '@/lib/renderHostClient';
import { replaceBodyInner } from '@/lib/templateDoc';
import { htmlWorker } from '@/workers';

// 文書組み立て(隔離描画 → sanitize → format)は結合 PDF と共用のため
// `lib/pdfDocument.ts` が持つ。文言定数は既存の import 元を保つため再エクスポートする。
export { PDF_ERROR_MSG };

const RENDER_ERROR_MSG = 'プレビューを表示できませんでした。テンプレートの内容をご確認ください。';

interface PreviewLoad {
  template: Template;
  sample: SampleData;
  /** Jinja を復元した HTML(draft があれば適用済み)。save と PDF で使う。 */
  restoredHtml: string;
  css: string;
  /** プレビュー iframe 用の自己完結 HTML ドキュメント。 */
  previewDoc: string;
  /** ユーザー向けレンダリングエラー。正常にレンダリングできた場合は null。 */
  renderError: string | null;
  /**
   * 自動保存された draft が存在するか。画面が「変更なし」を出す判断にだけ使う。
   * 申請の可否はこれで決めない — 差分の有無は精査画面がその場で計算するのが正で、
   * ここで止めると「差分計算が劣化しただけ」のときに正当な申請まで塞ぐ。
   */
  hasDraft: boolean;
  /**
   * `tpl.filled` が非空 = 値入り HTML。申請本文と描画は Jinja を通さない。
   */
  isFilled: boolean;
}

interface TemplatePreviewService {
  loadForPreview(id: string): Promise<Result<PreviewLoad>>;
  /**
   * テンプレートをサーバー経由で PDF blob にレンダリングする。`cropMarks` が true のとき
   * トンボ用 CSS(`CROP_MARKS_CSS`)を css へ連結する(プレビュー表示と同じ見た目にする)。
   * `skipJinja` は値入り HTML(`isFilled`)のとき true。
   */
  renderPdf(
    html: string,
    css: string,
    sample: SampleData,
    cropMarks: boolean,
    skipJinja: boolean,
  ): Promise<Result<Blob>>;
  recordPdfExport(id: string): Promise<Result<void>>;
}

export function createTemplatePreviewService(
  templates: TemplateRepository,
  history: HistoryRepository,
  owner: DraftOwner = draftOwner,
): TemplatePreviewService {
  return {
    async loadForPreview(id) {
      const tplRes = await templates.getTemplate(id);
      if (isErr(tplRes)) return tplRes;
      const tpl = tplRes.value;

      // 値入り HTML(`tpl.filled`)は `toFilled` がテキストノードへ値を差し込んだ本文で、
      // 属性内 Jinja(`href="css/{{ fund.code }}.css"` 等)は round-trip 保持のため設計上
      // 残る。描画を通す必要が無いどころか、通すと地の文の `{{` 風の字面まで nunjucks が
      // 式として解釈して本文が静かに欠ける。本文の源も `tpl.html`(Jinja 骨組み)ではなく
      // `tpl.filled` を採る — local ではこの 2 つが別物(REST は同じ本文が両方へ入る)。
      // `filled` はテストのフェイクや旧応答で欠けうるので、空文字と未定義をまとめて「無し」にする。
      const isFilled = Boolean(tpl.filled);

      // 値入り HTML は nunjucks を通さないので差し込み値そのものが要らない。サンプルを
      // 取りに行くと、値の出どころを持たない配備でも取得失敗がプレビュー全体の失敗になる。
      let sample: SampleData = {};
      if (!isFilled) {
        const sampleRes = await templates.getSampleData(tpl.meta.attributes.fundCode);
        if (isErr(sampleRes)) return sampleRes;
        // 版種・基準日(ファイル名由来)を被せる。getSampleData はファンド単位で属性を持たない。
        sample = applyTemplateAttributes(sampleRes.value, tpl.meta.attributes);
      }

      const draftRes = await templates.getDraft(id);
      if (isErr(draftRes)) return draftRes;
      // 編集経路(`loadForEdit`)と同じ所属判定を通す。ブックマークや直 URL で編集画面を
      // 経由せずここへ来ても、別タブが残した下書きを申請本文にしないため。破棄そのものは
      // 編集経路に任せ、ここでは採用しない(確定版でプレビューする)だけに留める。
      const draft = draftRes.value && owner.belongsToSession(id) ? draftRes.value : null;

      const baseHtml = isFilled ? tpl.filled : tpl.html;
      let restoredHtml: string;
      let css: string;
      if (draft && isFilled) {
        // 値入り HTML の下書きは値を保った本文そのもの。Jinja 復元は掛けない(掛けると
        // round-trip 用のチップから Jinja が戻り、承認で filled/ に Jinja が書かれる)。
        restoredHtml = replaceBodyInner(baseHtml, draft.html);
        css = formatCss(draft.css);
      } else if (draft) {
        // Jinja 復元(DOM 重処理)は Worker(linkedom)で実行しメインを塞がない。`pretty` で
        // 復元 HTML を整形し、確定保存される `data/templates` が git に読める形になる。
        // `toTemplate` は復元マスクの形状検査に失敗すると throw する(canvas 入口を素通りした
        // 攻撃形 draft の検出)。comlink 越しでも promise reject で届くので Result へ写す。
        let restoredBody: string;
        try {
          restoredBody = await htmlWorker.toTemplate(draft.html, {
            asFragment: true,
            pretty: true,
          });
        } catch (e) {
          return err(validation(RENDER_ERROR_MSG, { cause: e }));
        }
        restoredHtml = replaceBodyInner(baseHtml, restoredBody);
        css = formatCss(draft.css);
      } else {
        // draft 無し(編集前)は確定版の本文をそのまま使う。生 Jinja HTML は整形しない(構文破壊
        // 回避)。CSS は静的なので整形して保存形を揃える(整形済みでも冪等)。
        restoredHtml = baseHtml;
        css = formatCss(tpl.css);
      }

      let previewDoc = '';
      let renderError: string | null = null;
      if (isFilled) {
        // 値入り HTML を描画へ通さない理由は上の `isFilled` の定義箇所を参照。
        previewDoc = assemblePreviewDocument(restoredHtml, css);
      } else {
        // 描画は opaque オリジンの iframe(`renderHostClient`)、サニタイズ + 文書組み立て
        // (コンパイルを伴わない安価な処理)はメインで行う。Worker へ載せていた頃は同一
        // オリジンで nunjucks をコンパイルしており、隔離としては何も守っていなかった。
        const rendered = await renderJinjaIsolated(restoredHtml, sample);
        if (rendered.error) {
          logError(unexpected('preview render failed', { cause: rendered.error }));
          renderError = RENDER_ERROR_MSG;
        } else {
          previewDoc = assemblePreviewDocument(rendered.html, css);
        }
      }
      return ok({
        template: tpl,
        sample,
        restoredHtml,
        css,
        previewDoc,
        renderError,
        hasDraft: !!draft,
        isFilled,
      });
    },

    async renderPdf(html, css, sample, cropMarks, skipJinja) {
      try {
        const doc = await renderPdfDocument(html, css, sample, { cropMarks, skipJinja });
        if (isErr(doc)) return doc;
        const res = await fetch(apiUrl(apiPaths.build), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc.value),
        });
        if (!res.ok) return err(conflict(PDF_ERROR_MSG, { cause: `HTTP ${res.status}` }));
        return ok(await res.blob());
      } catch (e) {
        return err(conflict(PDF_ERROR_MSG, { cause: e }));
      }
    },

    recordPdfExport: (id) => history.recordPdfExport(id),
  };
}

export const useTemplatePreviewService = (): TemplatePreviewService =>
  createTemplatePreviewService(useTemplateRepo(), useHistoryRepo());
