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
import { countJinjaBlockOpens } from '@/lib/jinjaLex';
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
  /**
   * 確定版の CSS を `css` と同じ書き出し・整形にしたもの(申請の `cssBaseline`)。承認時の
   * ペア同期は、これと `css` の差を変わった規則として見る。下書きがあって編集画面が測って
   * いなければ null。
   */
  cssBaseline: string | null;
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

/** 下書きから申請するのに CSS の baseline が無いときの知らせ(申請は止めない)。 */
export const CSS_BASELINE_MISSING_MSG =
  'このまま申請するとペアの版種へ CSS が写りません。編集画面から開き直してください';

/**
 * 申請画面に出す CSS の baseline の知らせ。下書きがあって baseline が無い(別タブ・ブックマークから
 * 開いた等)ときだけ返す。そのまま申請すると、承認はペアへの CSS の転写を飛ばす。
 */
export function cssBaselineNotice(hasDraft: boolean, cssBaseline: string | null): string | null {
  return hasDraft && cssBaseline === null ? CSS_BASELINE_MISSING_MSG : null;
}

/** 申請する本文で Jinja のブロックが減っているときに、申請の確認の説明へ足す一文。 */
export const JINJA_BLOCK_LOSS_MSG = (n: number): string =>
  `元のテンプレートより Jinja のブロック（{% if %} など）が ${n} 個少なくなっています。` +
  '意図した削除でなければ、申請せずに編集画面で確かめてください。';

/**
 * 元のテンプレートと申請する本文の、閉じを持つ Jinja のブロックの開きの数を比べ、減っていれば
 * 確認の説明に足す一文を返す(減っていない・どちらかが字句として読めないときは null)。作成経路
 * だけが使う(編集経路の本文は値入りで Jinja を持たない)。
 */
export function jinjaBlockLossNotice(original: string, restored: string): string | null {
  const before = countJinjaBlockOpens(original);
  const after = countJinjaBlockOpens(restored);
  if (before === null || after === null || after >= before) return null;
  return JINJA_BLOCK_LOSS_MSG(before - after);
}

interface TemplatePreviewService {
  /**
   * `editorCssBaseline` は編集画面が測った確定版の CSS の形(`stores/editorSession.ts` の
   * `cssBaselineOf`)。下書きから申請するときの `cssBaseline` の素になる。
   */
  loadForPreview(
    id: string,
    opts?: { editorCssBaseline?: string | null },
  ): Promise<Result<PreviewLoad>>;
  /**
   * テンプレートをサーバー経由で PDF blob にレンダリングする。`cropMarks` が true のとき
   * トンボ用 CSS(`CROP_MARKS_CSS`)を css へ連結する(プレビュー表示と同じ見た目にする)。
   * `skipJinja` は値入り HTML(`isFilled`)のとき true。`companyCode` はテンプレ ID の会社コード
   * (会社フォルダの画像の照合用。省略・null は会社フォルダの画像を落とす)。
   */
  renderPdf(
    html: string,
    css: string,
    sample: SampleData,
    cropMarks: boolean,
    skipJinja: boolean,
    companyCode?: string | null,
  ): Promise<Result<Blob>>;
  recordPdfExport(id: string): Promise<Result<void>>;
}

export function createTemplatePreviewService(
  templates: TemplateRepository,
  history: HistoryRepository,
  owner: DraftOwner = draftOwner,
): TemplatePreviewService {
  return {
    async loadForPreview(id, opts = {}) {
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
        // 復元 HTML を整形し、確定保存される `<dataRoot>/templates` が git に読める形になる。
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
      // 申請の `cssBaseline`。`css` と同じ書き出し・同じ整形の「確定版の CSS」にする。下書きが
      // 無ければ `css` 自体が確定版。下書きがあれば編集画面が測った形を同じ整形に通す。測れて
      // いなければ null(申請に載せず、承認はペアへの CSS の転写だけを飛ばす)。
      const editorBaseline = opts.editorCssBaseline ?? null;
      const cssBaseline = !draft ? css : editorBaseline !== null ? formatCss(editorBaseline) : null;
      return ok({
        template: tpl,
        sample,
        restoredHtml,
        css,
        cssBaseline,
        previewDoc,
        renderError,
        hasDraft: !!draft,
        isFilled,
      });
    },

    async renderPdf(html, css, sample, cropMarks, skipJinja, companyCode = null) {
      try {
        const doc = await renderPdfDocument(html, css, sample, {
          cropMarks,
          skipJinja,
          companyCode,
        });
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
