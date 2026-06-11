<script setup lang="ts">
import {
  type DropdownQuery,
  isErr,
  type TemplateMeta,
  type TemplateVersionMeta,
  toAppError,
} from '@editor/shared';
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Info,
  Layers,
  Loader2,
} from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import BackButton from '@/components/ui/BackButton.vue';
import Button from '@/components/ui/Button.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import SearchFilters from '@/features/templates/components/SearchFilters.vue';
import { logError } from '@/lib/appError';
import { formatDateTime } from '@/lib/format';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useCompareService } from './services/compareService';
import { computeVisualDiff, type DiffPage, type PageStatus, type VisualDiff } from './useVisualDiff';

const compare = useCompareService();
const { run, loading } = useAsyncResult();

// --- step 1: pick the template ---------------------------------------------
const matched = ref<TemplateMeta[]>([]);
const templateId = ref<string | undefined>(undefined);
const templateOptions = computed(() =>
  matched.value.map((m) => ({ label: m.fileName, value: m.id })),
);

async function refreshTemplates(query: DropdownQuery) {
  const res = await run(() => compare.listTemplates(query));
  if (isErr(res)) return;
  matched.value = res.value;
  if (res.value.length === 1) templateId.value = res.value[0].id;
  else if (!res.value.some((m) => m.id === templateId.value)) templateId.value = undefined;
}

onMounted(() => refreshTemplates({}));

// --- step 2: pick two versions ---------------------------------------------
const versions = ref<TemplateVersionMeta[]>([]);
// A = 比較元(前回, older), B = 比較先(今回, newer)
const versionA = ref<string | undefined>(undefined);
const versionB = ref<string | undefined>(undefined);
const versionLabel = (v: TemplateVersionMeta) => `${formatDateTime(v.timestamp)} ・ ${v.user}`;
const versionOptions = computed(() =>
  versions.value.map((v) => ({ label: versionLabel(v), value: v.historyId })),
);
const notEnoughVersions = computed(
  () => !!templateId.value && !loading.value && versions.value.length < 2,
);

watch(templateId, async (id) => {
  versions.value = [];
  versionA.value = undefined;
  versionB.value = undefined;
  resetDiff();
  if (!id) return;
  const res = await run(() => compare.listVersions(id));
  if (isErr(res)) return;
  versions.value = res.value; // newest first
  if (res.value.length >= 2) {
    versionB.value = res.value[0].historyId;
    versionA.value = res.value[1].historyId;
  } else if (res.value.length === 1) {
    versionB.value = res.value[0].historyId;
  }
});

// --- comparison rendering ---------------------------------------------------
type Mode = 'side' | 'diff' | 'swipe';
const MODES: { value: Mode; label: string; icon: typeof Columns2 }[] = [
  { value: 'side', label: '並べて', icon: Columns2 },
  { value: 'diff', label: '差分', icon: Layers },
  { value: 'swipe', label: 'スワイプ', icon: ArrowLeftRight },
];
const mode = ref<Mode>('side');
const swipe = ref(50);

const diff = ref<VisualDiff | null>(null);
const rendering = ref(false);
const compareError = ref<string | null>(null);
const currentPage = ref(0);

const busy = computed(() => rendering.value || loading.value);
const pageCount = computed(() => diff.value?.pages.length ?? 0);
const page = computed<DiffPage | null>(() => diff.value?.pages[currentPage.value] ?? null);
const changedPages = computed(() => diff.value?.pages.filter((p) => p.status !== 'same') ?? []);

const STATUS_LABEL: Record<PageStatus, string> = {
  same: '変更なし',
  changed: '変更あり',
  added: '追加',
  removed: '削除',
};
const STATUS_CLASS: Record<PageStatus, string> = {
  same: 'bg-muted text-muted-foreground',
  changed: 'bg-destructive/10 text-destructive',
  added: 'bg-success/15 text-success',
  removed: 'bg-warning/15 text-warning',
};

function resetDiff() {
  diff.value = null;
  compareError.value = null;
  currentPage.value = 0;
}

function goPage(i: number) {
  currentPage.value = Math.min(Math.max(i, 0), Math.max(pageCount.value - 1, 0));
}

watch([versionA, versionB], () => void runCompare());

async function runCompare() {
  resetDiff();
  const a = versionA.value;
  const b = versionB.value;
  if (!a || !b) return;
  if (a === b) {
    compareError.value = '異なる版を選んでください。';
    return;
  }
  rendering.value = true;
  try {
    const [ra, rb] = await Promise.all([
      run(() => compare.renderVersion(a)),
      run(() => compare.renderVersion(b)),
    ]);
    if (isErr(ra) || isErr(rb)) return; // a toast was already shown
    diff.value = await computeVisualDiff(ra.value, rb.value);
  } catch (e) {
    logError(toAppError(e));
    compareError.value = '比較画像の生成に失敗しました。時間をおいて再度お試しください。';
  } finally {
    rendering.value = false;
  }
}

const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3">
      <BackButton :fallback="{ name: 'edit' }" label="ホーム" />
      <h2 class="text-lg font-semibold">版の比較</h2>
    </div>

    <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Info class="h-3.5 w-3.5" />
      確定保存した版の見た目を画像で比較します。比較できるのは本機能導入後に確定保存した版です。
    </p>

    <!-- step 1: template -->
    <SearchFilters search-label="絞り込み" @update="refreshTemplates" @search="refreshTemplates" />

    <!-- step 1 & 2: 選択パネル（白カードに載せる） -->
    <div class="space-y-4 rounded-lg border bg-card p-4">
      <div class="max-w-md space-y-1.5">
        <Label>テンプレート</Label>
        <Select
          v-model="templateId"
          :options="templateOptions"
          placeholder="テンプレートを選択"
          :disabled="busy"
        />
      </div>

      <div v-if="templateId" class="grid gap-3 sm:grid-cols-2 sm:max-w-2xl">
        <div class="space-y-1.5">
          <Label>比較元（前回）</Label>
          <Select
            v-model="versionA"
            :options="versionOptions"
            placeholder="版を選択"
            :disabled="busy || versions.length === 0"
          />
        </div>
        <div class="space-y-1.5">
          <Label>比較先（今回）</Label>
          <Select
            v-model="versionB"
            :options="versionOptions"
            placeholder="版を選択"
            :disabled="busy || versions.length === 0"
          />
        </div>
      </div>
    </div>

    <p v-if="notEnoughVersions" class="text-sm text-muted-foreground">
      このテンプレートには比較できる版が足りません（確定保存が2回以上必要です）。
    </p>
    <p v-if="compareError" class="text-sm text-destructive">{{ compareError }}</p>

    <!-- comparison -->
    <div v-if="rendering" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" /> 比較画像を生成中…
    </div>

    <div v-if="diff" class="space-y-3">
      <!-- toolbar -->
      <div class="flex flex-wrap items-center gap-3 border-b pb-3">
        <div class="inline-flex rounded-md border p-0.5">
          <button
            v-for="m in MODES"
            :key="m.value"
            type="button"
            :aria-pressed="mode === m.value"
            class="inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium transition-colors"
            :class="
              mode === m.value
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            "
            @click="mode = m.value"
          >
            <component :is="m.icon" class="h-4 w-4" />
            {{ m.label }}
          </button>
        </div>

        <span
          class="rounded-full px-2 py-0.5 text-xs font-medium"
          :class="changedPages.length ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'"
        >
          変更ありページ: {{ diff.changedPageCount }} / {{ pageCount }}
        </span>

        <div class="ml-auto flex items-center gap-1">
          <Button variant="outline" size="icon" :disabled="currentPage <= 0" @click="goPage(currentPage - 1)">
            <ChevronLeft class="h-4 w-4" />
          </Button>
          <span class="min-w-[5rem] text-center text-sm">ページ {{ currentPage + 1 }} / {{ pageCount }}</span>
          <Button
            variant="outline"
            size="icon"
            :disabled="currentPage >= pageCount - 1"
            @click="goPage(currentPage + 1)"
          >
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>
      </div>

      <!-- changed-page jump strip -->
      <div v-if="changedPages.length" class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted-foreground">変更ありへ移動:</span>
        <button
          v-for="p in changedPages"
          :key="p.index"
          type="button"
          class="rounded px-2 py-0.5 text-xs font-medium"
          :class="STATUS_CLASS[p.status]"
          @click="goPage(p.index)"
        >
          P{{ p.index + 1 }}
        </button>
      </div>

      <!-- current page -->
      <div v-if="page" class="space-y-2">
        <div class="flex items-center gap-2 text-sm">
          <span class="rounded px-2 py-0.5 text-xs font-medium" :class="STATUS_CLASS[page.status]">
            {{ STATUS_LABEL[page.status] }}
          </span>
          <span v-if="page.status === 'changed'" class="text-xs text-muted-foreground">
            変更画素 {{ pct(page.changedRatio) }}
          </span>
        </div>

        <!-- side by side -->
        <div v-if="mode === 'side'" class="grid gap-3 md:grid-cols-2">
          <figure class="space-y-1">
            <figcaption class="text-xs text-muted-foreground">前回</figcaption>
            <div class="overflow-auto rounded border bg-muted">
              <img v-if="page.beforeUrl" :src="page.beforeUrl" alt="前回" class="mx-auto block w-full bg-white" />
              <p v-else class="p-8 text-center text-sm text-muted-foreground">（このページは存在しません）</p>
            </div>
          </figure>
          <figure class="space-y-1">
            <figcaption class="text-xs text-muted-foreground">今回</figcaption>
            <div class="overflow-auto rounded border bg-muted">
              <img v-if="page.afterUrl" :src="page.afterUrl" alt="今回" class="mx-auto block w-full bg-white" />
              <p v-else class="p-8 text-center text-sm text-muted-foreground">（このページは存在しません）</p>
            </div>
          </figure>
        </div>

        <!-- diff overlay -->
        <div v-else-if="mode === 'diff'" class="overflow-auto rounded border bg-muted">
          <img
            v-if="page.diffUrl"
            :src="page.diffUrl"
            alt="差分"
            class="mx-auto block w-full max-w-3xl bg-white"
          />
          <p v-else class="p-8 text-center text-sm text-muted-foreground">
            片側にしか存在しないページのため差分はありません。
          </p>
        </div>

        <!-- swipe / onion-skin -->
        <div v-else class="space-y-2">
          <div v-if="page.beforeUrl && page.afterUrl" class="relative mx-auto max-w-3xl overflow-hidden rounded border bg-white">
            <img :src="page.afterUrl" alt="今回" class="block w-full" />
            <img
              :src="page.beforeUrl"
              alt="前回"
              class="absolute inset-0 block w-full"
              :style="{ clipPath: `inset(0 ${100 - swipe}% 0 0)` }"
            />
            <div class="absolute inset-y-0 w-0.5 bg-primary" :style="{ left: `${swipe}%` }"></div>
          </div>
          <p v-else class="rounded border bg-muted p-8 text-center text-sm text-muted-foreground">
            片側にしか存在しないページのためスワイプ比較はできません。
          </p>
          <div v-if="page.beforeUrl && page.afterUrl" class="mx-auto flex max-w-3xl items-center gap-2">
            <span class="text-xs text-muted-foreground">前回</span>
            <input v-model.number="swipe" type="range" min="0" max="100" class="flex-1" />
            <span class="text-xs text-muted-foreground">今回</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
