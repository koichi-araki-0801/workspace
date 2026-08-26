// =============================================================================
// reviewRepo.ts — 確定保存の精査者承認ワークフローの local 実装(オフラインデモ用ミラー)
// =============================================================================
// localStorage に申請(`K.reviews`)を積む。submit は実反映せず pending を作り、approve は
// `confirmSaveLocal`(本文 override + 公開 meta + 履歴 + snapshot + instance
// + draft 破棄)を再利用して反映してから申請を approved にする。ロール強制は本番(REST)が担い、
// ここは表示の絞り込み(approver|admin は全件、それ以外は自分の申請のみ)程度に留める。
import {
  type ApproveReviewResult,
  conflict,
  isApprover,
  isErr,
  notFound,
  parseTemplateFileName,
  type ReviewDecisionRequest,
  type ReviewListFilter,
  type ReviewRepository,
  type ReviewRequest,
  type SubmitReviewRequest,
  toReviewMeta,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, uid, write } from './store';
import { confirmSaveLocal, localTemplateRepo } from './templateRepo';

/** 現行版(現在の本文 override + CSS override)の簡易コンテンツキー(djb2)。 */
function contentKey(html: string, css: string): string {
  let h = 5381;
  const s = `${html}\x00${css}`;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function readReviews(): Record<string, ReviewRequest> {
  return read<Record<string, ReviewRequest>>(K.reviews, {});
}

export const localReviewRepo: ReviewRepository = {
  submitReview: (req: SubmitReviewRequest) =>
    attempt(async () => {
      const attrs = parseTemplateFileName(`${req.templateId}.html`);
      if (!attrs) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
      // 現行版を読み、baseHash(並行性警告の素)を取る。失敗しても申請自体は妨げない。
      const cur = await localTemplateRepo.getTemplate(req.templateId);
      const baseHash = isErr(cur) ? null : contentKey(cur.value.html, cur.value.css);
      const who = currentUser()?.displayName ?? '不明';
      const review: ReviewRequest = {
        id: uid('rv'),
        templateId: req.templateId,
        attributes: attrs,
        fundCode: req.fundCode,
        origin: req.origin,
        status: 'pending',
        submittedBy: who,
        submittedAt: now(),
        reviewedBy: null,
        reviewedAt: null,
        comment: null,
        baseHash,
        html: req.html,
        css: req.css,
        ...(req.filledHtml !== undefined ? { filledHtml: req.filledHtml } : {}),
        ...(req.changedSummary !== undefined ? { changedSummary: req.changedSummary } : {}),
      };
      const reviews = readReviews();
      reviews[review.id] = review;
      write(K.reviews, reviews);
      return delay(toReviewMeta(review));
    }),

  listReviews: (filter?: ReviewListFilter) =>
    attempt(() => {
      const user = currentUser();
      const canSeeAll = isApprover(user);
      const me = user?.displayName ?? '';
      const metas = Object.values(readReviews())
        .filter((r) => (filter?.status ? r.status === filter.status : true))
        .filter((r) => canSeeAll || r.submittedBy === me)
        .map(toReviewMeta)
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
      return delay(metas);
    }),

  getReview: (reqId: string) =>
    attempt(() => {
      const review = readReviews()[reqId];
      if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
      return delay(review);
    }),

  approveReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attempt(async () => {
      const reviews = readReviews();
      const review = reviews[reqId];
      if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
      if (review.status === 'approved' || review.status === 'rejected')
        throw conflict('この申請は既に処理済みです');
      // 反映前に現行版を再計測し、申請時点の baseHash と食い違えば警告する(申請後に別の確定が
      // 割り込んだ = 上書き注意)。ブロックはしない。baseHash 未記録の申請は警告しない。
      const cur = await localTemplateRepo.getTemplate(review.templateId);
      const staleWarning =
        review.baseHash !== null &&
        !isErr(cur) &&
        review.baseHash !== contentKey(cur.value.html, cur.value.css);
      // 実反映は既存の confirmSaveLocal 経路を再利用する(履歴/snapshot/instance も同時に積む)。
      const who = currentUser()?.displayName ?? '不明';
      // 申請の処理済み化を反映と同一 tx に載せる。別々に書くと、反映後に申請の書込だけが
      // 失敗した場合に「本文は公開済みなのに申請は承認待ち」が残り、二重承認できてしまう。
      const applied = await confirmSaveLocal(
        {
          templateId: review.templateId,
          html: review.html,
          css: review.css,
          fundCode: review.fundCode,
          filledHtml: review.filledHtml,
        },
        {
          keys: [K.reviews],
          commit: () => {
            reviews[reqId] = {
              ...review,
              status: 'approved',
              reviewedBy: who,
              reviewedAt: now(),
              comment: decision.comment ?? null,
            };
            write(K.reviews, reviews);
          },
        },
      );
      if (isErr(applied)) throw applied.error;
      const result: ApproveReviewResult = { meta: applied.value, staleWarning };
      return result;
    }),

  rejectReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attempt(() => {
      const reviews = readReviews();
      const review = reviews[reqId];
      if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
      if (review.status === 'approved' || review.status === 'rejected')
        throw conflict('この申請は既に処理済みです');
      const who = currentUser()?.displayName ?? '不明';
      const next: ReviewRequest = {
        ...review,
        status: 'rejected',
        reviewedBy: who,
        reviewedAt: now(),
        comment: decision.comment ?? null,
      };
      reviews[reqId] = next;
      write(K.reviews, reviews);
      return delay(toReviewMeta(next));
    }),

  holdReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attempt(() => {
      const reviews = readReviews();
      const review = reviews[reqId];
      if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
      if (review.status === 'approved' || review.status === 'rejected')
        throw conflict('この申請は既に処理済みです');
      const who = currentUser()?.displayName ?? '不明';
      const next: ReviewRequest = {
        ...review,
        status: 'held',
        heldBy: who,
        heldAt: now(),
        holdComment: decision.comment ?? null,
      };
      reviews[reqId] = next;
      write(K.reviews, reviews);
      return delay(toReviewMeta(next));
    }),
};
