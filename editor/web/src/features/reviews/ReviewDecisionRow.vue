<script setup lang="ts">
// =============================================================================
// ReviewDecisionRow.vue — 承認タブ右欄「変更と判定」の 1 行(番号・名前・文字の差分・判定)
// =============================================================================
// 文字の差分(`textOps`)は親画面の DOM にエスケープして描く。紙面は申請者の CSS が動く iframe で
// 変更を隠せるので、承認判断の正典はこちら(Global Constraints)。行の押下は `select`、チェック・
// ボタン・理由欄の押下は行の選択にしない(`onRowClick` が操作部品からの押下を除く)。
import type { PaperDecision } from '@editor/shared';
import { computed, ref, watch } from 'vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import { REJECT_REASON_MAX, rejectReasonProblem } from './reviewDecisionList';
import type { ReviewChangeRow } from './services/reviewDiffService';

const props = defineProps<{
  change: ReviewChangeRow;
  status: PaperDecision;
  /** 却下の理由(却下済みのときだけ意味を持つ)。 */
  reason: string | null;
  canDecide: boolean;
  busy: boolean;
  selected: boolean;
  picked: boolean;
}>();

const emit = defineEmits<{
  select: [];
  pick: [value: boolean];
  approve: [];
  reject: [reason: string];
  undo: [];
}>();

const KIND_BADGE = {
  changed: { label: '変更', variant: 'warning' },
  added: { label: '追加', variant: 'success' },
  removed: { label: '削除', variant: 'destructive' },
} as const;

/** 番号の色(モックの値。紙面の番号札と同じ固定色)。 */
const NO_COLOR: Record<PaperDecision, string> = {
  pending: 'bg-[#3b82c4]',
  approved: 'bg-[#2f8a5f]',
  rejected: 'bg-[#c0392b]',
};

const STATUS_LABEL: Record<PaperDecision, string> = {
  pending: '承認待ち',
  approved: '承認済み',
  rejected: '却下済み',
};

const rejectOpen = ref(false);
const draft = ref('');
const emptyError = ref(false);
const tooLong = computed(() => rejectReasonProblem(draft.value) === 'tooLong');
const pickable = computed(() => props.canDecide && props.status === 'pending' && !rejectOpen.value);

// 判定が届いたら(保存に成功したら)理由欄を閉じる。失敗で届かなければ開いたまま書き直せる。
watch(
  () => props.status,
  (s) => {
    if (s !== 'pending') closeReject();
  },
);
watch(draft, (v) => {
  if (v.trim()) emptyError.value = false;
});

function openReject() {
  rejectOpen.value = true;
}

function closeReject() {
  rejectOpen.value = false;
  draft.value = '';
  emptyError.value = false;
}

function submitReject() {
  const problem = rejectReasonProblem(draft.value);
  if (problem === 'empty') emptyError.value = true;
  if (problem !== null) return;
  emit('reject', draft.value.trim());
}

/** 行の押下。チェック・ボタン・理由欄(とその枠)からの押下は行の選択にしない。 */
function onRowClick(e: MouseEvent) {
  if ((e.target as Element).closest('input, button, textarea, label, [data-review-row-controls]')) {
    return;
  }
  emit('select');
}

function onPick(e: Event) {
  emit('pick', (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <li
    :data-review-row-no="change.no"
    :data-selected="selected ? 'true' : 'false'"
    :aria-current="selected ? 'true' : undefined"
    class="grid cursor-pointer gap-1.5 border-b px-3.5 py-2.5"
    :class="selected ? 'bg-primary/10' : 'hover:bg-muted/40'"
    @click="onRowClick"
  >
    <div class="flex min-w-0 items-center gap-2">
      <span v-if="pickable" class="flex items-center">
        <input
          type="checkbox"
          class="h-3.5 w-3.5 cursor-pointer accent-primary"
          :checked="picked"
          :aria-label="`${change.name}をまとめて判定する対象に選ぶ`"
          @change="onPick"
        />
      </span>
      <span v-else-if="canDecide" class="w-3.5 shrink-0" aria-hidden="true" />
      <span
        data-review-no
        :data-decision="status"
        class="inline-grid h-5 min-w-5 shrink-0 place-items-center whitespace-nowrap rounded-full px-1 text-xs font-bold text-white"
        :class="NO_COLOR[status]"
        >{{ change.no }}</span
      >
      <span data-review-name class="min-w-0 truncate text-sm font-bold" :title="change.label">{{
        change.name
      }}</span>
      <Badge data-review-kind :variant="KIND_BADGE[change.kind].variant" class="shrink-0">
        {{ KIND_BADGE[change.kind].label }}
      </Badge>
    </div>

    <p
      v-if="change.textOps.length"
      class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
    >
      <template v-for="(op, i) in change.textOps" :key="i">
        <del v-if="op.type === 'del'" class="rounded-sm bg-red-100 text-red-800 line-through">{{
          op.text
        }}</del>
        <ins
          v-else-if="op.type === 'ins'"
          class="rounded-sm bg-green-100 text-green-800 no-underline"
          >{{ op.text }}</ins
        >
        <span v-else>{{ op.text }}</span>
      </template>
    </p>
    <!-- 差分自体は必ず出す。着色を諦めた旨だけ控えめに添える(今の承認画面の文言)。 -->
    <p
      v-if="change.coarse"
      class="text-xs text-muted-foreground"
      title="この箇所は変更が大きいため、変わった文字ごとの色分けはせず全文を並べています。"
    >
      この箇所は変更が大きいため、変わった文字の色付けはせず全文を並べています
    </p>

    <!-- 閲覧のみ(決着済み・権限なし): 状態と理由だけ。 -->
    <div v-if="!canDecide" class="grid gap-1">
      <div>
        <Badge
          :variant="status === 'approved' ? 'success' : status === 'rejected' ? 'destructive' : 'warning'"
        >
          {{ STATUS_LABEL[status] }}
        </Badge>
      </div>
      <p v-if="status === 'rejected' && reason" class="break-words text-xs text-destructive">
        理由: {{ reason }}
      </p>
    </div>

    <div v-else-if="rejectOpen" data-review-row-controls class="grid cursor-default gap-1">
      <label class="text-xs font-bold" :for="`review-reject-${change.no}`">
        却下の理由（このパーツ・必須）
      </label>
      <textarea
        :id="`review-reject-${change.no}`"
        v-model="draft"
        rows="2"
        placeholder="申請者が直せるように理由を書きます"
        :aria-invalid="emptyError || tooLong || undefined"
        class="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="emptyError || tooLong ? 'border-destructive' : 'border-input'"
      />
      <p v-if="emptyError" role="alert" class="text-xs text-destructive">理由を入力してください。</p>
      <p v-if="tooLong" role="alert" class="text-xs text-destructive">
        理由は {{ REJECT_REASON_MAX }} 文字までです（いま {{ draft.length }} 文字）。
      </p>
      <p class="text-xs text-muted-foreground">理由は申請者の編集画面に表示します。</p>
      <div class="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" @click="closeReject">取消</Button>
        <Button
          size="sm"
          variant="outline"
          class="border-destructive/50 text-destructive"
          :disabled="busy || tooLong"
          @click="submitReject"
          >却下する</Button
        >
      </div>
    </div>

    <div v-else-if="status === 'pending'" data-review-row-controls class="flex items-center justify-end gap-2">
      <Button
        size="sm"
        variant="outline"
        class="border-destructive/50 text-destructive"
        :disabled="busy"
        @click="openReject"
        >却下…</Button
      >
      <Button size="sm" :disabled="busy" @click="emit('approve')">承認</Button>
    </div>

    <div v-else class="grid gap-1">
      <p v-if="status === 'rejected' && reason" class="break-words text-xs text-destructive">
        理由: {{ reason }}
      </p>
      <div class="flex items-center gap-2">
        <Badge :variant="status === 'approved' ? 'success' : 'destructive'">
          {{ STATUS_LABEL[status] }}
        </Badge>
        <Button
          size="sm"
          variant="link"
          class="ml-auto text-muted-foreground"
          :disabled="busy"
          @click="emit('undo')"
          >判定を取り消す</Button
        >
      </div>
    </div>
  </li>
</template>
