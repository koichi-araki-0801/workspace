// =============================================================================
// review.ts — 承認ワークフローのドメイン純関数
// =============================================================================
// web と `server` の双方で使える、依存なしの純関数を置く(`template.ts` と同方針)。

import { REVIEW_BASE_CHANGED, REVIEW_NOT_REVIEWABLE } from '../errors.js';
import type {
  ReviewPartDecision,
  ReviewRequest,
  ReviewRequestMeta,
  StoredReviewRequest,
} from '../index.js';

/**
 * `partDecisions` を必ず持つreview型。保存契約では旧reviewとの互換のためoptionalだが、
 * 読取り後の処理では欠落を空配列へ正規化して分岐を重複させない。
 */
export type ReviewWithPartDecisions<T extends ReviewRequestMeta | ReviewRequest> = T & {
  partDecisions: ReviewPartDecision[];
};
/**
 * 旧reviewで欠落する `partDecisions` を空配列へ正規化する。
 * server の `meta.json` の読取り境界で使う。
 */
export function normalizeReviewPartDecisions<T extends ReviewRequestMeta | ReviewRequest>(
  review: T,
): ReviewWithPartDecisions<T> {
  return {
    ...review,
    partDecisions: review.partDecisions ?? [],
  };
}

/**
 * 申請から本体(html/css/renderedHtml/cssBaseline/baseHtml/baseCss)と、読むたびに決まる
 * `renderError` を剥がした軽量メタを返す(一覧 API・meta.json 用)。`renderedHtml` は本文 1 本分の
 * 大きさなので `reviews/<id>/rendered.html` に置き、メタには書かない。
 * `ReviewRequest` は `ReviewRequestMeta` に本体系フィールドを足した定義(`schemas.ts`)なので、
 * 本体系フィールドを増やしたらここへも追記が要る。剥がす処理を各所に複製すると追記漏れの
 * 実装が型エラーなしで本文をメタ/一覧へ混入させる(肥大化・漏えい)ため、本関数へ集約する。
 */
export function toReviewMeta(r: StoredReviewRequest): ReviewRequestMeta {
  const {
    html: _h,
    css: _c,
    renderedHtml: _r,
    renderError: _e,
    cssBaseline: _baseline,
    baseHtml: _baseHtml,
    baseCss: _baseCss,
    ...meta
  } = r;
  return meta;
}

/**
 * 保存している申請から、単件の取得の応答(`ReviewRequest`)を作る。`cssBaseline` は承認時の
 * ペア同期だけが読むので剥がす(承認画面へ CSS 1 本分を余計に送らない)。
 */
export function toReviewResponse(r: StoredReviewRequest): ReviewRequest {
  const { cssBaseline: _b, ...rest } = r;
  return rest;
}

/** 日時の表示(申請日時など)。`YYYY/MM/DD HH:mm` のゼロ埋めで、実行環境の現地時刻で数える。 */
export function formatDateTimeYmdHm(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 判定・最終確定の 409(`REVIEW_BASE_CHANGED` / `REVIEW_NOT_REVIEWABLE`)の文言。server が返し、
 * web の承認画面が code で分岐して同じ文を出す。
 */
export const REVIEW_BASE_CHANGED_MESSAGE =
  '申請の後で確定版が変わりました。申請し直してもらってください';
export const REVIEW_NOT_REVIEWABLE_MESSAGE =
  'この申請は今の検査を通らないため承認できません。申請し直してもらってください';

/** 申請し直しを求める 409 の code なら、その文言(ほかの code は null)。 */
export function reviewResubmitMessage(code: string | undefined): string | null {
  if (code === REVIEW_BASE_CHANGED) return REVIEW_BASE_CHANGED_MESSAGE;
  if (code === REVIEW_NOT_REVIEWABLE) return REVIEW_NOT_REVIEWABLE_MESSAGE;
  return null;
}

/**
 * 同じ内容の承認待ちが既にあるときの拒否文言。server と web が同じ文を使うよう
 * ここに置く(`code: 'REVIEW_DUPLICATE'` と対で使う)。
 */
export function duplicateReviewMessage(existingSubmittedAt: string): string {
  return (
    `同じ内容の確定保存申請が既に承認待ちです（${formatDateTimeYmdHm(existingSubmittedAt)}に申請）。` +
    '新しい申請は作りませんでした。'
  );
}
