// =============================================================================
// useReviewDecisions.ts — 承認タブの判定の保存と手元の判定状態
// =============================================================================
// 保存は 1 回の要求にまとめ、成功したら応答の `partDecisions` で手元を差し替える(読み直さない)。
// 失敗したときだけ読み直す。トーストはここで出し、View は結果の真偽だけ見る。
import {
  type AppError,
  buildReviewedHtmlCandidate,
  type HtmlDiff,
  isErr,
  REVIEW_ALREADY_DECIDED,
  REVIEW_PART_DECISION_TRANSITION,
  type Result,
  type ReviewPartDecision,
  type ReviewRequest,
  reviewResubmitMessage,
  type UpdateReviewPartDecisionsRequest,
} from '@editor/shared';
import { type ComputedRef, computed, type Ref, ref, watch } from 'vue';
import { toast } from '@/components/ui/toast';
import {
  type DecisionCounts,
  decisionCounts,
  mergeSavedDecisions,
  rejectedSignature as rejectedSignatureOf,
} from './reviewDecisionState';
import type { ReviewChangeRow } from './services/reviewDiffService';

export function useReviewDecisions(ctx: {
  review: Ref<ReviewRequest | null>;
  diff: Ref<HtmlDiff | null>;
  changes: Ref<ReviewChangeRow[]>;
  save: (input: UpdateReviewPartDecisionsRequest) => Promise<Result<ReviewPartDecision[]>>;
  /** 読み直す。読めたら true(「画面を読み直しました」と言ってよいか)。 */
  reload: () => Promise<boolean>;
}): {
  decisions: ComputedRef<ReviewPartDecision[]>;
  counts: ComputedRef<DecisionCounts>;
  pendingPartKeys: ComputedRef<string[]>;
  unknownDecisionPartKeys: ComputedRef<string[]>;
  duplicateDecisionPartKeys: ComputedRef<string[]>;
  rejectedSignature: ComputedRef<string>;
  /** 保存中。真の間は approve / reject / undo を受け付けない(View はこれで押せなくする)。 */
  saving: Ref<boolean>;
  approve(partKeys: string[]): Promise<boolean>;
  reject(partKeys: string[], reason: string): Promise<boolean>;
  undo(partKey: string): Promise<boolean>;
} {
  const local = ref<ReviewPartDecision[]>([]);
  watch(
    () => ctx.review.value,
    (r) => {
      local.value = [...(r?.partDecisions ?? [])];
    },
    { immediate: true },
  );

  const saving = ref(false);
  const decisions = computed(() => local.value);
  const counts = computed(() => decisionCounts(ctx.changes.value, local.value));
  const candidate = computed(() =>
    ctx.diff.value === null ? null : buildReviewedHtmlCandidate(ctx.diff.value, local.value),
  );

  async function failed(error: AppError): Promise<false> {
    const reloaded = await ctx.reload();
    // 読み直しに失敗したときは「読み直しました」と言わない(読み込みの失敗は別に知らされる)。
    const tail = reloaded ? '画面を読み直しました。' : '';
    if (error.code === REVIEW_PART_DECISION_TRANSITION) {
      toast(`ほかの方が判定を変えました。${tail}`, 'error');
    } else if (error.code === REVIEW_ALREADY_DECIDED) {
      toast(`この申請はすでに処理されています。${tail}`, 'error');
    } else if (reviewResubmitMessage(error.code) !== null) {
      // 申請の後で確定版が変わった・今の検査を通らない申請。判定し直しても通らないので、申請し直しを
      // 求める(サーバと同じ文言。`useReviewDiff` がサーバの文言のトーストを黙らせている)。
      toast(reviewResubmitMessage(error.code) as string, 'error');
    } else {
      toast('パーツ判定の保存に失敗しました。', 'error');
    }
    return false;
  }

  async function send(input: UpdateReviewPartDecisionsRequest): Promise<boolean> {
    // 連打で古い応答が新しい応答を上書きしたり、reload が飛行中の要求を追い越したりしないよう、
    // 保存中は次を受け付けない。
    if (saving.value) return false;
    saving.value = true;
    try {
      const res = await ctx.save(input);
      if (isErr(res)) return await failed(res.error);
      local.value = mergeSavedDecisions(local.value, res.value);
      return true;
    } finally {
      saving.value = false;
    }
  }

  return {
    decisions,
    counts,
    pendingPartKeys: computed(() => candidate.value?.pendingPartKeys ?? []),
    unknownDecisionPartKeys: computed(() => candidate.value?.unknownDecisionPartKeys ?? []),
    duplicateDecisionPartKeys: computed(() => candidate.value?.duplicateDecisionPartKeys ?? []),
    rejectedSignature: computed(() => rejectedSignatureOf(local.value)),
    saving,
    approve: (partKeys) =>
      send({ decisions: partKeys.map((partKey) => ({ partKey, status: 'approved' as const })) }),
    reject: (partKeys, reason) =>
      send({
        decisions: partKeys.map((partKey) => ({
          partKey,
          status: 'rejected' as const,
          comment: reason,
        })),
      }),
    undo: (partKey) => send({ decisions: [{ partKey, status: 'pending' }] }),
  };
}
