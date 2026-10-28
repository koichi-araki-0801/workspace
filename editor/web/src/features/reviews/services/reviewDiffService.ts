// =============================================================================
// reviewDiffService.ts — 承認画面のパーツ単位 前後プレビュー(diff)の組み立て
// =============================================================================
// 申請(`ReviewRequest`)を、現行版(baseline)と同一描画経路で diff し、パーツ(= 本文直下の
// top-level block。改ページの区切りは除く)ごとの着色済み前後 HTML を「行」として返す。diff 計算は版比較
// (`CompareView`)と完全共有(`htmlWorker.buildHtmlDiff` + `htmlBlockDiff` の `DiffBlock`)。
// 現行版・申請版とも `compareService` の素の sample 描画に揃え、見せかけ差分を避ける。
import {
  type ChangedPart,
  type HtmlDiff,
  isErr,
  numberChangedParts,
  ok,
  type PartRepository,
  partDisplayName,
  partNameOfHtml,
  type Result,
  type ReviewRepository,
  type ReviewRequest,
} from '@editor/shared';
import { usePartRepo, useReviewRepo } from '@/api/repositories';
import {
  createLcsBudget,
  type DiffOp,
  diffTokens,
  hasPrintOnlyRules,
  type LcsBudget,
  tokenize,
} from '@/features/compare/htmlBlockDiff';
import {
  type CompareService,
  renderReviewPair,
  useCompareService,
} from '@/features/compare/services/compareService';
import { defaultHtmlParser } from '@/lib/htmlParser';
import { loadPartNameMap, partNameOf } from '@/lib/partNames';
import { getBodyInner } from '@/lib/templateDoc';
import { htmlWorker } from '@/workers';

/** 承認画面の 1 変更パーツ行(番号つきの `ChangedPart` に表示名と本文語句差分を足したもの)。 */
export interface ReviewChangeRow extends ChangedPart {
  /** 表示名。業務名 → 先頭の文字 → 「ページN・パーツM」の順(`partDisplayName`)。 */
  name: string;
  /**
   * 申請者スタイルの影響を受けない**本文テキストの語句差分**。着色済みプレビューは申請者 CSS を
   * 載せた iframe で描くため、申請者は未保護プロパティで変更箇所を隠せる。`textContent` は
   * CSS を無視するので、この語句差分には隠された変更も現れる。移動したパーツは削除側の before と
   * 追加側の after で作る。
   */
  textOps: DiffOp[];
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
  /** 変更のあるパーツ(`numberChangedParts` の順)。 */
  changes: ReviewChangeRow[];
  /** 差分そのもの(手元で最終候補・判定の不足を出すのに使う)。 */
  diff: HtmlDiff;
  summary: ReviewChangeSummary;
  /** before ペイン(現行版)のファンド CSS。 */
  cssBefore: string;
  /** after ペイン(申請版)のファンド CSS。 */
  cssAfter: string;
  /** before(現行版)の本文全体 HTML。見た目比較(`ReviewVisualCompare`)の左面に渡す。 */
  beforeBodyHtml: string;
  /** after(申請版)の本文全体 HTML。見た目比較(`ReviewVisualCompare`)の右面に渡す。 */
  afterBodyHtml: string;
  /**
   * 変更のあったページの index(0 始まり。`buildHtmlDiff` の `diff.pages` 由来)。
   * 見た目比較(`ReviewVisualCompare`)がマーカー・アンカーを付けるページの集合になる。
   */
  changedPageIndexes: number[];
  /**
   * diff 計算(`buildHtmlDiff`)が数えた before/after 各面の期待ページ数
   * (`HtmlDiff.beforePageCount`/`afterPageCount`)。見た目比較(`buildCompareDocs`)が
   * 文書から数えたページ数と突き合わせ、不一致(CSS の page-break 欠落等でページ分割が
   * 潰れた場合)なら誤ったページへのマーカー誘導を避けるため無印へ degrade する。
   */
  beforePageCount: number;
  afterPageCount: number;
  /**
   * 資源上限で差分に現れなかった領域があるか。**承認者へ必ず伝える**。
   * 承認すると確定書込は申請本文を全文書くので、ここが真のまま承認されると
   * 「承認者が一度も見ていない内容」が本番へ入る。
   */
  truncated: boolean;
  /**
   * ファンド共通 CSS が現行版と変わっているか。パーツ(HTML)差分が 0 でも per-fund CSS は
   * 承認で `writeTemplateAndCss` により上書きされ、以後そのファンドの全テンプレ・全 PDF に
   * 効く。HTML 差分だけを見て「変更なし」と表示すると、承認者が見ていない CSS 変更が
   * そのまま本番へ入る。承認画面はこのフラグが真なら「変更なし」を出さず、CSS 差分を見せる。
   */
  cssChanged: boolean;
  /**
   * 申請で適用され得る全スタイルシート(ファンド CSS + 申請 HTML 内のインライン `<style>`)に
   * 印刷時だけ効く規則があるか。承認者の見え(screen)と成果物(print)が乖離しうるので注記を
   * 出す。関門ではない。
   */
  printOnlyCss: boolean;
}

/** CSS の実質的な差分判定。空白差(整形・改行)は差分と見なさない。 */
function normalizeCssForCompare(css: string): string {
  return css.replace(/\s+/g, ' ').trim();
}

/** 着色済みマークアップから**表示テキスト**を取り出す。`textContent` は CSS を無視するので、
 *  `display:none` や `@media` で隠された本文もここには現れる(申請者スタイルで隠せない)。 */
function htmlToText(html: string): string {
  if (!html.trim()) return '';
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

/**
 * 変更前後の本文テキストの語句差分。承認画面が申請者 CSS の影響を受けずに描く照合の正典。
 * `budget` は**文書 1 件ぶんを 1 つだけ**渡す(呼び出しごとに新規確保しない) — ブロックごとに
 * 予算を切ると、worker 側の文書単位セル上限(`MAX_LCS_TOTAL_CELLS`)をメインスレッド経路で
 * 回避でき、変更ブロックを多数含む申請 1 件で承認者タブを固められる。
 */
function textWordOps(beforeHtml: string, afterHtml: string, budget: LcsBudget): DiffOp[] {
  return diffTokens(tokenize(htmlToText(beforeHtml)), tokenize(htmlToText(afterHtml)), budget).ops;
}

/**
 * 承認ペインで実際に適用され得る全スタイルシートのテキストを 1 本に集める。
 * ファンド CSS に加え、申請 HTML 内のインライン `<style>`(能動コンテンツとして意図的に
 * 残される)も対象にする。印刷差異検査は `srcdoc` へ埋めるのと同じ文字列から計算しないと、
 * 「検査はファンド CSS だけ、実際に効くのは本文の `<style>` も」というズレで素通りする。
 */
function collectPaneStyleText(afterHtml: string, fundCss: string): string {
  const parts: string[] = [];
  if (fundCss.trim()) parts.push(fundCss);
  try {
    const doc = new DOMParser().parseFromString(afterHtml, 'text/html');
    for (const el of Array.from(doc.querySelectorAll('style'))) {
      const t = el.textContent ?? '';
      if (t.trim()) parts.push(t);
    }
  } catch {
    // パースできない場合でもファンド CSS 側の検査は生かす(黙って false に倒さない)。
  }
  return parts.join('\n');
}

interface ReviewDiffService {
  /** 申請 1 件を読み、現行版と diff してパーツ行を組み立てる。 */
  buildDiff(reqId: string): Promise<Result<ReviewDiffData>>;
}

export function createReviewDiffService(
  reviews: ReviewRepository,
  compare: CompareService,
  parts: PartRepository,
): ReviewDiffService {
  return {
    async buildDiff(reqId) {
      const revRes = await reviews.getReview(reqId);
      if (isErr(revRes)) return revRes;
      const review = revRes.value;

      // after(申請版)は申請本文そのもの。作成タブ由来なら素の sample で描画する。
      // before(現行版)= 既存編集なら現公開版、作成(新規)や取得できない(初回確定前など)なら空。
      const pairRes =
        review.origin === 'create' && review.filledHtml
          ? ok({
              before: { html: '', css: review.css },
              after: {
                html: getBodyInner(review.filledHtml),
                css: review.css,
              },
            })
          : await renderReviewPair(compare, {
              templateId: review.templateId,
              html: review.html,
              css: review.css,
              origin: review.origin,
            });

      if (isErr(pairRes)) return pairRes;

      const pair = pairRes.value;
      const after = pair.after;
      const before =
        review.baseHtml !== undefined && review.baseCss !== undefined
          ? {
              ...pair.before,
              html: review.baseHtml,
              css: review.baseCss,
            }
          : pair.before;

      const diff = await htmlWorker.buildHtmlDiff(before.html, after.html, before.css, after.css);
      // パーツカタログの業務名突合はベストエフォート(取得失敗は空 Map へ degrade)。
      const nameById = await loadPartNameMap(parts);
      // 本文語句差分の LCS 予算は**文書 1 件で 1 つ**(worker の `diffPairs` と同じ規律)。
      // 全パーツで使い切る形にして、ブロック数で計算量を青天井にできないようにする。
      const textBudget = createLcsBudget();
      const changes: ReviewChangeRow[] = numberChangedParts(diff).map((part) => ({
        ...part,
        name: partDisplayName({
          catalogName: partNameOf(part.partKey, nameById),
          firstText: partNameOfHtml(part.rawAfterHtml || part.rawBeforeHtml, defaultHtmlParser),
          fallbackLabel: part.label,
        }),
        textOps: textWordOps(part.beforeHtml, part.afterHtml, textBudget),
      }));
      const blocks = diff.pages.flatMap((p) => p.blocks);
      const summary: ReviewChangeSummary = {
        total: blocks.length,
        changed: blocks.filter((b) => b.status === 'changed').length,
        added: blocks.filter((b) => b.status === 'added').length,
        removed: blocks.filter((b) => b.status === 'removed').length,
      };

      return ok({
        review,
        changes,
        diff,
        summary,
        cssBefore: before.css,
        cssAfter: after.css,
        beforeBodyHtml: before.html,
        afterBodyHtml: after.html,

        changedPageIndexes: diff.pages.filter((p) => p.changed).map((p) => p.index),
        beforePageCount: diff.beforePageCount,
        afterPageCount: diff.afterPageCount,
        truncated: diff.truncated,
        cssChanged: normalizeCssForCompare(before.css) !== normalizeCssForCompare(after.css),
        printOnlyCss: hasPrintOnlyRules(collectPaneStyleText(after.html, after.css)),
      });
    },
  };
}

export const useReviewDiffService = (): ReviewDiffService =>
  createReviewDiffService(useReviewRepo(), useCompareService(), usePartRepo());
