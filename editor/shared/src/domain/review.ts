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
