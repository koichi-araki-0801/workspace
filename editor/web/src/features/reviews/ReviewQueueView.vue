<script setup lang="ts">
// =============================================================================
// ReviewQueueView.vue — 確定保存の承認キュー(申請一覧)
// =============================================================================
// 精査者(approver|admin)は全件、編集者(editor)は自分の申請のみ見える(`reviewRepo` が絞る)。
// 精査者は各申請を開いてパーツ単位の前後プレビューで精査し、承認/却下する(`ReviewDiffView`)。
import { isErr, type ReviewRequestMeta, type ReviewStatus } from '@editor/shared';
import { ClipboardCheck, Info } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewRepo } from '@/api/repositories';
import AttributeBar from '@/components/AttributeBar.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { formatDateTimeShort } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useAuthStore } from '@/stores/auth';

const reviews = useReviewRepo();
const auth = useAuthStore();
const router = useRouter();
const { loading, run } = useAsyncResult();

const items = ref<ReviewRequestMeta[]>([]);

// 状態フィルタ。既定は「承認待ち」(精査者の主作業)。
const STATUS_FILTERS: { label: string; value: ReviewStatus | 'all' }[] = [
  { label: '承認待ち', value: 'pending' },
  { label: '承認済', value: 'approved' },
  { label: '却下', value: 'rejected' },
  { label: 'すべて', value: 'all' },
];
const statusFilter = ref<ReviewStatus | 'all'>('pending');

const ORIGIN_LABEL: Record<ReviewRequestMeta['origin'], string> = {
  edit: '編集',
  create: '新規作成',
};

const STATUS_META: Record<
  ReviewStatus,
  { label: string; variant: 'warning' | 'success' | 'destructive' }
> = {
  pending: { label: '承認待ち', variant: 'warning' },
  approved: { label: '承認済', variant: 'success' },
  rejected: { label: '却下', variant: 'destructive' },
};

async function load() {
  const res = await run(() =>
    reviews.listReviews(
      statusFilter.value === 'all' ? {} : { status: statusFilter.value },
    ),
  );
  if (!isErr(res)) items.value = res.value;
}

function setFilter(v: ReviewStatus | 'all') {
  statusFilter.value = v;
  void load();
}

function openDetail(reqId: string) {
  router.push({ name: 'review-detail', params: { reqId } });
}

const heading = computed(() => (auth.isApprover ? '確定保存の承認' : '自分の確定保存申請'));

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-bold">{{ heading }}</h2>
      <p class="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Info class="h-3.5 w-3.5 shrink-0" />
        <span v-if="auth.isApprover">
          編集者からの確定保存申請を精査し、承認すると本番テンプレートへ反映されます。
        </span>
        <span v-else>
          申請した確定保存は精査者(承認者)の承認後に本番テンプレートへ反映されます。
        </span>
      </p>
    </div>

    <!-- 状態フィルタ -->
    <div class="flex flex-wrap items-center gap-1.5">
      <Button
        v-for="f in STATUS_FILTERS"
        :key="f.value"
        :variant="statusFilter === f.value ? 'default' : 'outline'"
        size="sm"
        @click="setFilter(f.value)"
      >
        {{ f.label }}
      </Button>
    </div>

    <!-- ロード中は申請カードと同構成のスケルトン(完了時のレイアウトシフトを防ぐ)。 -->
    <ul v-if="loading" class="space-y-2" aria-label="読み込み中">
      <li
        v-for="i in 3"
        :key="`skeleton-${i}`"
        class="flex items-center gap-3 rounded-[12px] border bg-card px-4 py-3 shadow-sm"
      >
        <Skeleton class="h-5 w-14" />
        <Skeleton class="h-5 w-12" />
        <Skeleton class="h-4 flex-1" />
        <Skeleton class="h-8 w-20" />
      </li>
    </ul>

    <EmptyState
      v-else-if="items.length === 0"
      :icon="ClipboardCheck"
      title="該当する申請はありません"
      hint="条件を変えるか、編集タブから確定保存を申請してください。"
    />

    <ul v-else class="space-y-2">
      <li
        v-for="r in items"
        :key="r.id"
        class="flex flex-wrap items-center gap-3 rounded-[12px] border bg-card px-4 py-3 shadow-sm"
      >
        <Badge :variant="STATUS_META[r.status].variant" class="shrink-0">
          {{ STATUS_META[r.status].label }}
        </Badge>
        <Badge variant="secondary" class="shrink-0">{{ ORIGIN_LABEL[r.origin] }}</Badge>
        <AttributeBar :attributes="r.attributes" class="min-w-0 flex-1" />
        <div class="flex shrink-0 flex-col items-end text-xs text-muted-foreground">
          <span>申請: {{ r.submittedBy }}・{{ formatDateTimeShort(r.submittedAt) }}</span>
          <span v-if="r.reviewedBy">
            {{ r.status === 'approved' ? '承認' : '却下' }}: {{ r.reviewedBy }}・{{
              formatDateTimeShort(r.reviewedAt)
            }}
          </span>
        </div>
        <Button size="sm" :variant="r.status === 'pending' && auth.isApprover ? 'default' : 'outline'" @click="openDetail(r.id)">
          {{ r.status === 'pending' && auth.isApprover ? '精査する' : '内容を見る' }}
        </Button>
      </li>
    </ul>
  </div>
</template>
