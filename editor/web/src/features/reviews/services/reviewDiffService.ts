// =============================================================================
// reviewDiffService.ts — 承認画面のパーツ単位 前後プレビュー(diff)の組み立て
// =============================================================================
// 申請(`ReviewRequest`)を、現行版(baseline)と同一描画経路で diff し、パーツ(= `.page`
// 直下 top-level block)ごとの着色済み前後 HTML を「行」として返す。diff 計算は版比較
// (`CompareView`)と完全共有(`htmlWorker.buildHtmlDiff` + `htmlBlockDiff` の `DiffBlock`)。
// 現行版・申請版とも `compareService` の素の sample 描画に揃え、見せかけ差分を避ける。
import { isErr, ok, type Result, type ReviewRepository, type ReviewRequest } from '@editor/shared';
import { useReviewRepo } from '@/api/repositories';
import { type BlockStatus, hasPrintOnlyRules } from '@/features/compare/htmlBlockDiff';
import { type CompareService, useCompareService } from '@/features/compare/services/compareService';
import { htmlWorker } from '@/workers';

/** 承認画面の 1 パーツ行(= `DiffBlock` を presentation 用に写したもの)。 */
export interface ReviewPartRow {
  key: string;
  /** 「ページN・パーツM」(`partLabelMap` と同採番)。 */
  label: string;
  status: BlockStatus;
  /** このパーツだけの着色済み変更前 HTML(added では空)。 */
  beforeHtml: string;
  /** このパーツだけの着色済み変更後 HTML(removed では空)。 */
  afterHtml: string;
}

/** パーツ行の集計(承認画面ヘッダの件数表示用)。 */
export interface ReviewChangeSummary {
  total: number;
  changed: number;
  added: number;
  removed: number;
}

interface ReviewDiffData {
  review: ReviewRequest;
  rows: ReviewPartRow[];
  summary: ReviewChangeSummary;
  /** before ペイン(現行版)のファンド CSS。 */
  cssBefore: string;
  /** after ペイン(申請版)のファンド CSS。 */
  cssAfter: string;
  /**
   * 資源上限で差分に現れなかった領域があるか。**承認者へ必ず伝える**。
   * 承認すると確定書込は申請本文を全文書くので、ここが真のまま承認されると
   * 「承認者が一度も見ていない内容」が本番へ入る。
   */
  truncated: boolean;
  /**
   * 申請 CSS に印刷時だけ効く規則があるか。承認者の見え(screen)と成果物(print)が
   * 乖離しうるので注記を出す。関門ではない。
   */
  printOnlyCss: boolean;
}

interface ReviewDiffService {
  /** 申請 1 件を読み、現行版と diff してパーツ行を組み立てる。 */
  buildDiff(reqId: string): Promise<Result<ReviewDiffData>>;
}

export function createReviewDiffService(
  reviews: ReviewRepository,
  compare: CompareService,
): ReviewDiffService {
  return {
    async buildDiff(reqId) {
      const revRes = await reviews.getReview(reqId);
      if (isErr(revRes)) return revRes;
      const review = revRes.value;

      // after(申請版)は常に申請本文を素の sample で描画する。
      const afterRes = await compare.renderTemplateBody(review.html, review.css, review.fundCode);
      if (isErr(afterRes)) return afterRes;
      const after = afterRes.value;

      // before(現行版)= 既存編集なら現公開版、作成(新規)なら空(= 全パーツが追加)。
      // 現行版が取得できない(初回確定前など)場合も空に倒し、画面自体は出す。
      let beforeHtml = '';
      let cssBefore = after.css;
      if (review.origin === 'edit') {
        const beforeRes = await compare.renderVersionHtml(`baseline:${review.templateId}`);
        if (!isErr(beforeRes)) {
          beforeHtml = beforeRes.value.html;
          cssBefore = beforeRes.value.css;
        }
      }

      const diff = await htmlWorker.buildHtmlDiff(beforeHtml, after.html, cssBefore, after.css);
      const rows: ReviewPartRow[] = diff.pages.flatMap((p) =>
        p.blocks.map((b) => ({
          key: b.key,
          label: b.label,
          status: b.status,
          beforeHtml: b.beforeHtml,
          afterHtml: b.afterHtml,
        })),
      );
      const summary: ReviewChangeSummary = {
        total: rows.length,
        changed: rows.filter((r) => r.status === 'changed').length,
        added: rows.filter((r) => r.status === 'added').length,
        removed: rows.filter((r) => r.status === 'removed').length,
      };
      return ok({
        review,
        rows,
        summary,
        cssBefore,
        cssAfter: after.css,
        truncated: diff.truncated,
        printOnlyCss: hasPrintOnlyRules(after.css),
      });
    },
  };
}

export const useReviewDiffService = (): ReviewDiffService =>
  createReviewDiffService(useReviewRepo(), useCompareService());
