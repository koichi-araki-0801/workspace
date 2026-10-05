// =============================================================================
// reviewRepo.ts — 確定保存の精査者承認ワークフローの local 実装(オフラインデモ用ミラー)
// =============================================================================
// localStorage に申請(`K.reviews`)を積む。submit は実反映せず pending を作り、approve は
// `confirmSaveLocal`(本文 override + 公開 meta + 履歴 + snapshot + instance
// + draft 破棄)を再利用して反映してから申請を approved にする。ロール強制は本番(REST)が担い、
// ここは表示の絞り込み(approver|admin は全件、それ以外は自分の申請のみ)程度に留める。
import {
  type ApproveReviewResult,
  anyTemplateFileName,
  conflict,
  isApprover,
  isErr,
  notFound,
  parseAnyTemplateFileName,
  type ReviewDecisionRequest,
  type ReviewListFilter,
  type ReviewRepository,
  type ReviewRequest,
  type ReviewStatus,
  type StoredReviewRequest,
  type SubmitReviewRequest,
  toReviewMeta,
  toReviewResponse,
  validation,
} from '@editor/shared';
import { attempt } from './attempt';
import { currentUser, delay, K, now, read, resolveFilled, uid, write } from './store';
import { confirmSaveLocal, localTemplateRepo } from './templateRepo';

/** 現行版(現在の本文 override + CSS override)の簡易コンテンツキー(djb2)。 */
function contentKey(html: string, css: string): string {
  let h = 5381;
  const s = `${html}\x00${css}`;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

const REVIEW_STATUSES: ReadonlySet<string> = new Set<ReviewStatus>([
  'pending',
  'approved',
  'rejected',
]);

/**
 * 保存済みの申請を読む。`status` が現行の 3 状態の外にある申請は読み飛ばす(server の
 * `reviewFiles.readReviewMeta` と同じ規則。1 件のために一覧全体を落とさない)。書き戻しは
 * この戻り値から組むので、読み飛ばした申請は次の書き込みで消える。
 */
function readReviews(): Record<string, StoredReviewRequest> {
  const raw = read<Record<string, StoredReviewRequest>>(K.reviews, {});
  const out: Record<string, StoredReviewRequest> = {};
  for (const [id, r] of Object.entries(raw)) {
    if (REVIEW_STATUSES.has(r.status)) out[id] = r;
  }
  return out;
}

/**
 * 編集経路の申請が満たすべき 2 条件。申請と承認の双方で見るのは、申請後に前提が崩れても
 * (作成タブの承認が割り込む)承認側で止めるため(server の `assertFilledPresentForEdit` と
 * 同じ構え)。判定は store を直接読む(`getTemplate` 経由にすると、現行版の取得失敗を握り潰す
 * 呼び出し側の経路と絡んで「取得できない = 拒否」に化ける)。
 *
 * - 値入り HTML が既に在ること。無いまま通すと、承認が値入り HTML を新規に作り、そこへ
 *   作成タブ由来の Jinja 骨組みが書かれる。
 * - 本文が空でないこと。local は空文字を「値入り HTML 無し」の印として使うので、空本文の
 *   承認はテンプレを黙って `draft` へ落とす(`store.ts` の `resolveFilled`)。
 */
function assertEditSubmissionAllowed(
  origin: ReviewRequest['origin'],
  templateId: string,
  attrs: ReviewRequest['attributes'],
  html: string,
): void {
  if (origin !== 'edit') return;
  if (html === '')
    throw validation(`編集タブの申請は本文が空では受け付けられません: ${templateId}`);
  if (resolveFilled(templateId, anyTemplateFileName(attrs)) === '')
    throw validation(`編集タブの申請には値入り HTML(filled)が必要です: ${templateId}`);
}

export const localReviewRepo: ReviewRepository = {
  submitReview: (req: SubmitReviewRequest) =>
    attempt(async () => {
      const attrs = parseAnyTemplateFileName(`${req.templateId}.html`);
      if (!attrs) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
      assertEditSubmissionAllowed(req.origin, req.templateId, attrs, req.html);
      // 現行版を読み、baseHash(並行性警告の素)を取る。失敗しても申請自体は妨げない。
      const cur = await localTemplateRepo.getTemplate(req.templateId);
      const baseHash = isErr(cur) ? null : contentKey(cur.value.html, cur.value.css);
      const who = currentUser()?.displayName ?? '不明';
      const review: StoredReviewRequest = {
        id: uid('rv'),
        templateId: req.templateId,
        attributes: attrs,
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
        ...(req.cssBaseline !== undefined ? { cssBaseline: req.cssBaseline } : {}),
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
      return delay(toReviewResponse(review));
    }),

  approveReview: (reqId: string, decision: ReviewDecisionRequest) =>
    attempt(async () => {
      const reviews = readReviews();
      const review = reviews[reqId];
      if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
      if (review.status === 'approved' || review.status === 'rejected')
        throw conflict('この申請は既に処理済みです');
      assertEditSubmissionAllowed(review.origin, review.templateId, review.attributes, review.html);
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
          origin: review.origin,
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
      // 却下理由は必須。rest 実装(サーバの `ReviewRejectBody`)と判定を揃えないと、
      // 同じ操作が local では通り rest では 400 になる。
      const comment = decision.comment?.trim() ?? '';
      if (!comment) throw validation('却下には理由が必要です');
      const reviews = readReviews();
      const review = reviews[reqId];
      if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
      if (review.status === 'approved' || review.status === 'rejected')
        throw conflict('この申請は既に処理済みです');
      const who = currentUser()?.displayName ?? '不明';
      const next: StoredReviewRequest = {
        ...review,
        status: 'rejected',
        reviewedBy: who,
        reviewedAt: now(),
        comment,
      };
      reviews[reqId] = next;
      write(K.reviews, reviews);
      return delay(toReviewMeta(next));
    }),
};
