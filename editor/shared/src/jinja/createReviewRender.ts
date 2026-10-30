// =============================================================================
// createReviewRender.ts — 作成経路の申請の本文を検査し、承認画面に見せる形に描く(受付の純関数)
// =============================================================================
// 承認画面は、確定する Jinja 原文からサーバが描いた本文だけを見せる。申請者が送る値入り HTML
// (`filledHtml`)を見せると、確定する原文と別の物(文言を差し替えた写し)を承認させられる。描き方は
// 全部の枝を描き、Python Jinja2 と同じ意味になる参照だけを値で描き、ほかは原文の文字で出す(shared の
// `renderPlainFilled` の reveal と `revealExpr.ts`)。全部の枝を連結した承認画面の姿と、採った枝だけの
// 本番の姿で読みが割れる原文は、受付で 400 にする(shared の `reviewableSource.ts`)。
// server の `reviewRepo.ts` の受付と、古い申請の描き直しが使う。I/O を持たず shared に置くのは、
// 承認画面に出ず本番だけに出る形の回帰を、申請のファイルを作らずに server(受付の全体)と web
// (承認画面の差分の経路)の両方で通すため。

import { validation } from '../errors.js';
import { extractReviewParts } from '../html/reviewParts.js';
import type { ReviewRenderNotes, SampleData } from '../index.js';
import {
  MAX_DOCUMENT_HTML_CHARS,
  MAX_RENDER_NOTE_SOURCE_CHARS,
  MAX_RENDER_NOTE_SOURCES,
} from '../schemas.js';
import { JinjaRenderSyntaxError, renderPlainFilled } from './fillRender.js';
import { JinjaBudget } from './jinjaExpr.js';
import {
  findReviewableIssues,
  headFixedSources,
  reviewableIssueMessage,
  stripLeadingBom,
} from './reviewableSource.js';

/**
 * 受付の描画の評価の量の上限。描画は同期の計算で、その間サーバ全体の要求が止まるので、既定の
 * `MAX_WORK`(200 万)より小さくする。2026-10-30 の測定(Python と同じ意味の参照だけを値で描く reveal):
 *   - 打ち切られない上限に近い帳票(fixture の本文を繰り返した約 305 万字・約 4,900 パーツ。差分の
 *     重さの計測と同じ規模)は、評価の量 41〜59 万、受付の検査の全体(パーツの読み取り 2 回・原文の
 *     検査・描画)で 0.36〜0.41 秒。描画結果は約 409 万字で、出力の上限の内に収まる。
 *   - 量や出力の上限まで仕事をさせる形(短い参照を 10 万回近く出す・値で描けない式を出し続ける)は
 *     0.3 秒前後。値で描けない式は評価しないので、評価器で失敗を出し続ける形(以前の最悪、約 1.8 秒)は
 *     もう重くない。帳票の量に対して 1.4 倍ほどの余裕を残して 80 万にする。
 */
const SUBMIT_RENDER_WORK = 800_000;

const RENDER_LIMIT_MESSAGE =
  '描画の量が上限を超えたため、承認画面に全体を表示できません。テンプレートを確かめてください';
const HEAD_CHANGED_MESSAGE =
  '<head> の中の <meta>・<title>・<style>・<link> は変更できません（承認画面に出ないため）。' +
  '変更が必要なら開発者へ依頼してください';

/** 原文のパーツのキーの並び。 */
const partKeysOf = (html: string) => extractReviewParts(html).map((part) => part.partKey);

/**
 * 作成経路の申請の本文を検査し、承認画面に見せる形に描く。止める形はどれも 400。
 *   1. 先頭の BOM を 1 文字だけ外す(検査と描画は外した原文に掛ける。保存する原文は変えない)。
 *   2. 原文のパーツを読む(パーツ識別子の Jinja・閉じていない境界は、判定・最終確定が決着できない)。
 *   3. 承認画面と本番で読みが割れる原文の検査(`findReviewableIssues`。トークンの位置・刈り込み・
 *      raw text の中のマークアップ・分岐の中の set・文書の骨格)。
 *   4. head の meta・title・style・link が基準(`baselineHtml`。生成物・確定テンプレート)と同じ並びか
 *      (meta の charset を変えると、本番だけ別の文字コードで読まれる)。
 *   5. 受付の上限(評価の量 `SUBMIT_RENDER_WORK`・出力 `MAX_DOCUMENT_HTML_CHARS`)で描く。
 *   6. 描画結果と原文のパーツのキーの並びを比べる(承認画面の判定のキーを原文へ当てるため)。
 * `MAX_DOCUMENT_HTML_CHARS` は申請本文と同じ上限で、パーツの走査の上限(`MAX_REVIEW_PART_SCAN_CHARS`)
 * より小さいので、6 の走査が上限で止まることは無い。
 */
export function renderCreateReview(
  html: string,
  sample: SampleData,
  baselineHtml: string,
): { renderedHtml: string; renderNotes: ReviewRenderNotes } {
  const src = stripLeadingBom(html);
  const sourceKeys = partKeysOf(src);
  const [issue] = findReviewableIssues(src, { document: true });
  if (issue !== undefined)
    throw validation(`${reviewableIssueMessage(issue.code)}（位置 ${issue.at}）`, {
      code: 'REVIEW_SOURCE_UNREVIEWABLE',
    });
  const head = headFixedSources(src);
  const base = headFixedSources(stripLeadingBom(baselineHtml));
  if (head.length !== base.length || head.some((h, i) => h !== base[i]))
    throw validation(HEAD_CHANGED_MESSAGE);
  let rendered: ReturnType<typeof renderPlainFilled>;
  try {
    rendered = renderPlainFilled(src, sample, {
      reveal: true,
      budget: new JinjaBudget(SUBMIT_RENDER_WORK),
      maxOutputChars: MAX_DOCUMENT_HTML_CHARS,
    });
  } catch (cause) {
    if (cause instanceof JinjaRenderSyntaxError)
      throw validation(`Jinja の書き方を読めないため申請できません（位置 ${cause.at}）`, { cause });
    throw cause;
  }
  const { diagnostics } = rendered;
  if (diagnostics.limitReached || rendered.html.length > MAX_DOCUMENT_HTML_CHARS)
    throw validation(RENDER_LIMIT_MESSAGE);
  const renderedKeys = partKeysOf(rendered.html);
  if (
    sourceKeys.length !== renderedKeys.length ||
    sourceKeys.some((key, i) => key !== renderedKeys[i])
  )
    throw validation('Jinja原文と描画結果のパーツ構造が一致しません');
  return {
    renderedHtml: rendered.html,
    renderNotes: {
      unrendered: diagnostics.unrenderedCount,
      escapedSafe: diagnostics.escapedSafe.length,
      unrenderedSources: diagnostics.unrendered
        .slice(0, MAX_RENDER_NOTE_SOURCES)
        .map((s) => s.slice(0, MAX_RENDER_NOTE_SOURCE_CHARS)),
    },
  };
}
