// =============================================================================
// useRejectedReasons.ts — 前回の申請で却下されたパーツの理由(編集画面の右ペイン「プロパティ」)
// =============================================================================
// 役割: 編集画面を開いた本人が出した、そのテンプレートの申請のうちいちばん新しいものを申請一覧
// (`listReviews` のメタ)から選び、決着済み(承認済み・却下済み)ならパーツの判定(`partDecisions`)
// の却下を理由としてキーごとに返す。描くのは `Inspector.vue`、並べるのは `historyGroups.ts`。
//
// 出さない場合と理由:
// - いちばん新しい申請が承認待ち: 判定はまだ途中で、承認タブで見るものだから。
// - 申請ごと却下の理由(`review.comment`): パーツに当たらないので、承認タブで読む。
// - 取得の失敗: 理由は補助の表示なので、空にして編集は止めない。本文(名前のため)だけの失敗は
//   理由を出し、紙面に無いパーツの見出しを `UNKNOWN_PART_NAME` にする(削除されたとは限らない)。
// 理由はコメント(notes)へは投稿しない(D1: コメントは種別を持たないメモ 1 種類)。

import {
  isOk,
  partNameOfElement,
  type ReviewPartDecision,
  type ReviewRepository,
  type ReviewRequestMeta,
} from '@editor/shared';
import { type Ref, ref } from 'vue';
import { logError } from '@/lib/appError';
import type { RejectedReason } from './historyGroups';
import { partEntries } from './partKey';

export type { RejectedReason } from './historyGroups';

type RejectedDecision = Extract<ReviewPartDecision, { status: 'rejected' }>;

/** 本文を取れず名前を作れなかった、紙面に無いパーツの見出し。 */
const UNKNOWN_PART_NAME = '名前の分からないパーツ';

/** 本人の、そのテンプレートの申請のうち、いちばん新しいもの。無ければ null。 */
function latestOwnReview(
  list: readonly ReviewRequestMeta[],
  templateId: string,
  me: string,
): ReviewRequestMeta | null {
  let latest: ReviewRequestMeta | null = null;
  for (const m of list) {
    if (m.templateId !== templateId || m.submittedBy !== me) continue;
    if (latest === null || m.submittedAt > latest.submittedAt) latest = m;
  }
  return latest;
}

/**
 * 申請の本文(値入りが有れば値入り)からパーツのキー → 名前を作る。キーは canvas と同じ規則
 * (`partEntries`、静的な文書なので既定の `rawKey`)で数えるので、判定の `partKey` で引ける。
 */
function namesFromBody(html: string, keys: ReadonlySet<string>): Map<string, string> {
  const root = new DOMParser().parseFromString(html, 'text/html').body;
  const out = new Map<string, string>();
  for (const e of partEntries(root)) {
    if (keys.has(e.key)) out.set(e.key, partNameOfElement(e.part));
  }
  return out;
}

export function useRejectedReasons(ctx: {
  templateId: string;
  /** 編集画面を開いた本人(申請の `submittedBy` と同じ `username`)。分からなければ null。 */
  me: () => string | null;
  reviews: ReviewRepository;
  /** 今の canvas のパーツのキー。ここに無いキーの却下だけ、申請の本文から名前を作る。 */
  canvasKeys: () => ReadonlySet<string>;
}): { reasons: Ref<Map<string, RejectedReason>>; reload(): Promise<void> } {
  const reasons = ref(new Map<string, RejectedReason>()) as Ref<Map<string, RejectedReason>>;

  async function reload(): Promise<void> {
    reasons.value = new Map();
    const me = ctx.me();
    if (me === null) return;
    const res = await ctx.reviews.listReviews({});
    if (!isOk(res)) {
      logError(res.error);
      return;
    }
    const latest = latestOwnReview(res.value, ctx.templateId, me);
    if (latest === null || latest.status === 'pending') return;
    const rejected = (latest.partDecisions ?? []).filter(
      (d): d is RejectedDecision => d.status === 'rejected',
    );
    if (rejected.length === 0) return;

    // canvas に無いキー(却下した追加・キーのずれ)だけ、名前のために本文を 1 回取る。
    const onCanvas = ctx.canvasKeys();
    const missing = new Set(rejected.map((d) => d.partKey).filter((k) => !onCanvas.has(k)));
    let names = new Map<string, string>();
    if (missing.size > 0) {
      const body = await ctx.reviews.getReview(latest.id);
      if (isOk(body)) names = namesFromBody(body.value.filledHtml || body.value.html, missing);
      else {
        logError(body.error);
        names = new Map([...missing].map((k) => [k, UNKNOWN_PART_NAME]));
      }
    }

    const out = new Map<string, RejectedReason>();
    for (const d of rejected) {
      out.set(d.partKey, {
        partKey: d.partKey,
        reason: d.comment,
        decidedBy: d.decidedBy,
        decidedAt: d.decidedAt,
        name: names.get(d.partKey) || null,
      });
    }
    reasons.value = out;
  }

  return { reasons, reload };
}
