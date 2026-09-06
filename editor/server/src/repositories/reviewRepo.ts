// =============================================================================
// reviewRepo.ts — 確定保存の精査者承認ワークフロー(サーバ REST 実装)
// =============================================================================
// 確定保存を「申請(submit)→ 承認(approve)/却下(reject)」の 2 段に割る。申請は実ファイルを
// 一切更新せず `data/reviews/` に積み(`reviewFiles.ts`)、承認時に限り `applyConfirmedSave`
// (`templateRepo.ts`)で実ファイル + git へ反映する。これが実ファイル書込の唯一の関所で、
// ルートは `requireApprover` で施錠する(`reviews.routes.ts`)。各関数は失敗時に `AppError`
// を throw し、HTTP 変換は中央 `errorHandler` に委ねる(`templateRepo.ts` と同方針)。
import { createHash, randomUUID } from 'node:crypto';
import {
  type ApproveReviewResult,
  conflict,
  forbidden,
  notFound,
  parseTemplateFileName,
  type ReviewDecisionRequest,
  type ReviewRequest,
  type ReviewRequestMeta,
  type ReviewStatus,
  type SubmitReviewRequest,
  templateFileName,
  toReviewMeta,
  unexpected,
  validation,
} from '@editor/shared';
import {
  countPendingReviews,
  listReviewMetas,
  MAX_PENDING_REVIEWS,
  readReview,
  updateReviewMeta,
  writeReview,
} from '../files/reviewFiles.js';
import { readFundCss, readTemplateHtml } from '../files/templateFiles.js';
import { assertTemplateScriptsUnchanged } from '../security/templateScripts.js';
import { reflectNoteMasterAfterConfirm } from '../sync/noteMasterService.js';
import { syncPairAfterConfirm } from '../sync/pairSyncService.js';
import { baselineTemplateHtml } from './confirmedWrite.js';
import { applyConfirmedSave } from './templateRepo.js';

/** 操作主体(認証済みユーザ)。ロールは自己承認/閲覧範囲の判定に使う。 */
export interface ReviewActor {
  username: string;
  role: string;
}

// ── 承認/却下の直列化(`gitRepo.ts` の `withGitLock` と同型) ──
// read→check→apply→updateMeta の間に他の承認/却下が割り込むと、同一申請の二重反映や
// 「実ファイルは反映済みなのに却下で確定」の矛盾が起きる(TOCTOU)。承認は人間操作で
// 低頻度のため、reqId 別の粒度は持たずモジュール全体の単一 Promise チェーンで直列化する。
let reviewLock: Promise<unknown> = Promise.resolve();
function withReviewLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = reviewLock.then(fn, fn);
  // チェーンは握りつぶして次へ繋ぐ(個々の結果は run が保持)。
  reviewLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 申請時点の現行版(現在のディスク本体)のコンテンツキー。承認時の並行性警告に使う。 */
async function currentBaseHash(templateId: string, fundCode: string): Promise<string> {
  const attrs = parseTemplateFileName(`${templateId}.html`);
  const fileName = attrs ? templateFileName(attrs) : `${templateId}.html`;
  const [html, css] = await Promise.all([readTemplateHtml(fileName), readFundCss(fundCode)]);
  return createHash('sha1').update(html).update('\x00').update(css).digest('hex');
}

/** approver|admin は全件、それ以外(editor)は自分の申請のみ閲覧できる。 */
function canSeeAll(actor: ReviewActor): boolean {
  return actor.role === 'approver' || actor.role === 'admin';
}

/**
 * 承認・却下が受け付ける現在状態の検査。決着(approved/rejected)済みを 409 で拒む。
 */
function assertUndecided(review: ReviewRequest): void {
  if (review.status === 'approved' || review.status === 'rejected')
    throw conflict(`この申請は既に${review.status === 'approved' ? '承認' : '却下'}済みです`);
}

/** 確定保存を申請する(pending 作成・実ファイル非更新)。 */
export async function submitReview(
  req: SubmitReviewRequest,
  actor: ReviewActor,
): Promise<ReviewRequestMeta> {
  const attrs = parseTemplateFileName(`${req.templateId}.html`);
  if (!attrs) throw notFound(`テンプレートが見つかりません: ${req.templateId}`);
  // 帰属検査は承認側(`applyConfirmedWrite`)と同条件で入口にも置く。CSS はファンド単位の
  // 共有ファイルなので不一致を通すと「承認できない申請」がキューに積まれるだけで、
  // 申請時に取る現行版ハッシュ(`baseHash`)も別ファンドの CSS を混ぜた値になる。
  if (attrs.fundCode !== req.fundCode) {
    throw validation(
      `ファンドコードがテンプレート id と一致しません: ${req.fundCode} (id=${req.templateId})`,
    );
  }
  // 実行コード面は生成時に確定し、以後どの経路でも変えられない。最後の関所は承認側の
  // `applyConfirmedWrite` だが、申請の入口でも同じ照合を掛ける — 通してしまうと精査者の
  // キューに「承認できない申請」が積まれ、承認者は実行結果しか見ないため差分にも気付けない。
  // 基準は確定テンプレ → 生成物(pending)の順(確定優先)で、いずれも `data-opaque` 等を
  // 復号した実体に対して比較する。
  assertTemplateScriptsUnchanged(await baselineTemplateHtml(req.templateId), req.html, {
    templateId: req.templateId,
    where: 'review-submit',
  });
  // 未処理申請の件数上限。作成は editor 1 ロールで撃て、1 件ごとに dataRoot へ書くので、
  // 上限が無いと 1 人で領域を埋めて承認フローごと止められる(`reviewsDir` は templates /
  // `.git` と同じボリューム)。判定は書き込みの前に置く — 通してから消すのでは遅い。
  if ((await countPendingReviews()) >= MAX_PENDING_REVIEWS)
    throw validation(
      `未処理の確定保存申請が上限(${MAX_PENDING_REVIEWS} 件)に達しています。` +
        '精査者が既存の申請を処理してから、あらためて申請してください。',
    );
  const review: ReviewRequest = {
    id: randomUUID(),
    templateId: req.templateId,
    attributes: attrs,
    fundCode: req.fundCode,
    origin: req.origin,
    status: 'pending',
    submittedBy: actor.username,
    submittedAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    comment: null,
    baseHash: await currentBaseHash(req.templateId, req.fundCode),
    ...(req.changedSummary !== undefined ? { changedSummary: req.changedSummary } : {}),
    html: req.html,
    css: req.css,
    ...(req.filledHtml !== undefined ? { filledHtml: req.filledHtml } : {}),
  };
  await writeReview(review);
  return toReviewMeta(review);
}

/** 申請一覧。状態で絞り込み、ロールで可視範囲を絞る。新しい順。 */
export async function listReviews(
  filter: { status?: ReviewStatus },
  actor: ReviewActor,
): Promise<ReviewRequestMeta[]> {
  const all = await listReviewMetas();
  return all
    .filter((m) => (filter.status ? m.status === filter.status : true))
    .filter((m) => canSeeAll(actor) || m.submittedBy === actor.username)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/**
 * 申請 1 件を本体込みで取得する(承認画面のプレビュー用)。閲覧範囲は一覧(`listReviews`)と
 * 対称にし、approver|admin または申請者本人のみに限る。それ以外(他人の申請を id 指定で
 * 覗く editor)は `forbidden`。id を知られても本体(html/css)が漏れないようにする。
 */
export async function getReview(reqId: string, actor: ReviewActor): Promise<ReviewRequest> {
  const review = await readReview(reqId);
  if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
  if (!canSeeAll(actor) && review.submittedBy !== actor.username)
    throw forbidden('この申請を閲覧する権限がありません');
  return review;
}

/**
 * 承認して実ファイルへ反映する(approver|admin のみ。ルートで施錠済み)。pending でなければ
 * 409。職務分掌のため自己承認(申請者 == 承認者)は既定で拒否し、admin のみ例外とする。
 */
export async function approveReview(
  reqId: string,
  decision: ReviewDecisionRequest,
  actor: ReviewActor,
): Promise<ApproveReviewResult> {
  return withReviewLock(async () => {
    const review = await readReview(reqId);
    if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
    assertUndecided(review);
    if (review.submittedBy === actor.username && actor.role !== 'admin')
      throw forbidden('自分の申請は承認できません(職務分掌)');

    // 反映前に現行版を再計測し、申請時点の baseHash と食い違えば警告する(申請後に別の確定が
    // 割り込んだ = 上書き注意)。ブロックはしない。baseHash 未記録(null)の申請は警告しない。
    const staleWarning =
      review.baseHash !== null &&
      review.baseHash !== (await currentBaseHash(review.templateId, review.fundCode));

    // git コミットに申請者・承認者の双方を残す(承認者を author、申請者を Co-Authored-By)。
    const commitMessage =
      `確定保存(承認): ${review.templateId} 申請=${review.submittedBy} 承認=${actor.username}\n\n` +
      `Co-Authored-By: ${review.submittedBy} <${review.submittedBy}@editor.local>`;
    const meta = await applyConfirmedSave({
      templateId: review.templateId,
      html: review.html,
      css: review.css,
      fundCode: review.fundCode,
      commitMessage,
      author: actor.username,
    });
    await finalizeApprovedMeta(reqId, {
      status: 'approved',
      reviewedBy: actor.username,
      reviewedAt: new Date().toISOString(),
      comment: decision.comment ?? null,
    });
    // 承認の完結後に交付版⇄全体版のパーツ自動同期を掛ける(ベストエフォート。失敗しても
    // 承認は成立済みで、結果/理由は summary として UI へ返す)。ペア対象外なら null。
    const sync = await syncPairAfterConfirm(review.templateId, actor.username);
    // 続けて `次回反映既定`=`反映` パーツの注記マスタ書き戻し(同じくベストエフォート)。
    // 契機は承認のみ = ペア同期で機械転写された側の版種はここでは書き戻さない
    // (その版種自身の承認時に昇格する)。
    const noteMaster = await reflectNoteMasterAfterConfirm(review.templateId, actor.username);
    return { meta, staleWarning, sync, noteMaster };
  });
}

/**
 * 承認確定のメタ更新。実ファイル反映(`applyConfirmedSave`)の後段で失敗すると「反映済みなのに
 * pending」が残り、再承認で二重反映されるため、一時失敗(ウイルス対策・インデクサ由来の
 * EPERM/EBUSY 等)は短い backoff で再試行し、それでも駄目なら手動復旧の手順を載せた明示エラー
 * にする。順序を逆(メタ先行)にするとクラッシュ時に「approved なのに未反映」というサイレント
 * 欠落になるため現行順(反映→メタ)を維持する。なお「現行版 hash が申請内容の hash と一致すれば
 * 既反映としてスキップ」する冪等検知は、`applyConfirmedSave` の CSS がファンド CSS へのマージ
 * で `review.css` と結果が一致せず判定不成立のため不採用。
 */
async function finalizeApprovedMeta(
  reqId: string,
  patch: Partial<ReviewRequestMeta>,
): Promise<void> {
  const ATTEMPTS = 3;
  let lastCause: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await updateReviewMeta(reqId, patch);
      return;
    } catch (cause) {
      lastCause = cause;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  throw unexpected(
    `承認結果の保存に失敗しました: ${reqId}。実ファイル反映と git コミットは完了済みのため、` +
      `再承認せず data/reviews/${reqId}/meta.json の status を手動で approved に更新してください` +
      '(この失敗で承認処理は中断するため、ペア自動同期と注記マスタ書き戻しは実行されて' +
      'いません。必要なら手動で反映してください)',
    { cause: lastCause, code: 'REVIEW_META_UPDATE_FAILED' },
  );
}

/** 却下する(approver|admin のみ。ルートで施錠済み)。実ファイルは更新しない。 */
export async function rejectReview(
  reqId: string,
  decision: ReviewDecisionRequest,
  actor: ReviewActor,
): Promise<ReviewRequestMeta> {
  return withReviewLock(async () => {
    const review = await readReview(reqId);
    if (!review) throw notFound(`申請が見つかりません: ${reqId}`);
    assertUndecided(review);
    return updateReviewMeta(reqId, {
      status: 'rejected',
      reviewedBy: actor.username,
      reviewedAt: new Date().toISOString(),
      comment: decision.comment ?? null,
    });
  });
}
