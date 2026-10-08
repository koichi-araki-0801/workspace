// =============================================================================
// review.ts — 承認ワークフローのドメイン純関数
// =============================================================================
// `web/api/local` と `server` の双方で使う、依存なしの純関数を置く(`template.ts` と同方針)。

import type { ReviewRequest, ReviewRequestMeta, StoredReviewRequest } from '../index.js';

/**
 * 申請から本体(html/css/filledHtml/cssBaseline)を剥がした軽量メタを返す(一覧 API・meta.json 用)。
 * `ReviewRequest` は `ReviewRequestMeta` に本体系フィールドを足した定義(`schemas.ts`)なので、
 * 本体系フィールドを増やしたらここへも追記が要る。剥がす処理を各所に複製すると追記漏れの
 * 実装が型エラーなしで本文をメタ/一覧へ混入させる(肥大化・漏えい)ため、本関数へ集約する。
 */
export function toReviewMeta(r: StoredReviewRequest): ReviewRequestMeta {
  const { html: _h, css: _c, filledHtml: _f, cssBaseline: _b, ...meta } = r;
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
 * 同じ内容の承認待ちが既にあるときの拒否文言。server と web local が同じ文を返すよう
 * ここに置く(`code: 'REVIEW_DUPLICATE'` と対で使う)。
 */
export function duplicateReviewMessage(existingSubmittedAt: string): string {
  return (
    `同じ内容の確定保存申請が既に承認待ちです（${formatDateTimeYmdHm(existingSubmittedAt)}に申請）。` +
    '新しい申請は作りませんでした。'
  );
}
