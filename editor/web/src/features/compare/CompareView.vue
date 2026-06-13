<script setup lang="ts">
import {
  type DropdownQuery,
  isErr,
  type TemplateMeta,
  type TemplateVersionMeta,
  toAppError,
} from '@editor/shared';
import { Info, Loader2 } from '@lucide/vue';
import { computed, onMounted, ref, watch } from 'vue';
import Step from '@/components/ui/Step.vue';
import SearchFilters from '@/features/templates/components/SearchFilters.vue';
import { logError } from '@/lib/appError';
import { useAsyncResult } from '@/lib/useAsyncResult';
import CompareCandidateTable from './CompareCandidateTable.vue';
import CompareResultView from './CompareResultView.vue';
import { buildHtmlDiff, type HtmlDiff } from './htmlBlockDiff';
import { type CompareCandidate, useCompareService } from './services/compareService';
import VersionPicker from './VersionPicker.vue';

const compare = useCompareService();
const { run, loading } = useAsyncResult();

type Phase = 'select' | 'result';
const phase = ref<Phase>('select');

// --- step 1: pick the template ---------------------------------------------
const candidates = ref<CompareCandidate[]>([]);
const templateId = ref<string | undefined>(undefined);
const selectedMeta = ref<TemplateMeta | null>(null);

async function refreshCandidates(query: DropdownQuery) {
  const res = await run(() => compare.listCandidates(query));
  if (isErr(res)) return;
  candidates.value = res.value;
  // 絞り込み後に現在の選択が一覧から消えたらクリアする。
  if (!res.value.some((c) => c.meta.id === templateId.value)) {
    templateId.value = undefined;
    selectedMeta.value = null;
  }
}

function onSelectTemplate(meta: TemplateMeta) {
  templateId.value = meta.id;
  selectedMeta.value = meta;
}

onMounted(() => refreshCandidates({}));

// --- step 2: pick two versions ---------------------------------------------
const versions = ref<TemplateVersionMeta[]>([]);
const notEnoughVersions = computed(
  () => !!templateId.value && !loading.value && versions.value.length < 2,
);

watch(templateId, async (id) => {
  versions.value = [];
  if (!id) return;
  const res = await run(() => compare.listVersions(id));
  if (isErr(res)) return;
  versions.value = res.value; // newest first
});

// --- comparison -------------------------------------------------------------
interface CompareResult {
  meta: TemplateMeta;
  before: TemplateVersionMeta;
  after: TemplateVersionMeta;
  diff: HtmlDiff;
  cssBefore: string;
  cssAfter: string;
}

const rendering = ref(false);
const compareError = ref<string | null>(null);
const result = ref<CompareResult | null>(null);

// a = 前回(older), b = 今回(newer)
async function onCompare({ a, b }: { a: string; b: string }) {
  compareError.value = null;
  const before = versions.value.find((v) => v.historyId === a);
  const after = versions.value.find((v) => v.historyId === b);
  if (!before || !after || !selectedMeta.value) return;

  rendering.value = true;
  try {
    const [ra, rb] = await Promise.all([
      run(() => compare.renderVersionHtml(a)),
      run(() => compare.renderVersionHtml(b)),
    ]);
    if (isErr(ra) || isErr(rb)) return; // a toast was already shown
    result.value = {
      meta: selectedMeta.value,
      before,
      after,
      diff: buildHtmlDiff(ra.value.html, rb.value.html),
      cssBefore: ra.value.css,
      cssAfter: rb.value.css,
    };
    phase.value = 'result';
  } catch (e) {
    logError(toAppError(e));
    compareError.value = '比較の生成に失敗しました。時間をおいて再度お試しください。';
  } finally {
    rendering.value = false;
  }
}

function back() {
  phase.value = 'select';
}
</script>

<template>
  <CompareResultView
    v-if="phase === 'result' && result"
    :meta="result.meta"
    :before="result.before"
    :after="result.after"
    :diff="result.diff"
    :css-before="result.cssBefore"
    :css-after="result.cssAfter"
    @back="back"
  />

  <div v-else class="space-y-4">
    <div>
      <h2 class="text-lg font-bold">版の比較</h2>
      <p class="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Info class="h-3.5 w-3.5 shrink-0" />
        比較する版を選んでから、比較画面に進みます。確定保存が2回以上ある版が対象です。
      </p>
    </div>

    <div class="rounded-[14px] border bg-card px-6 pb-1 pt-6 shadow-sm">
      <!-- Step 1 — narrow down the template -->
      <Step :n="1" title="比較するテンプレートを指定" :active="!templateId" :done="!!templateId">
        <SearchFilters
          search-label="絞り込み"
          bare
          @update="refreshCandidates"
          @search="refreshCandidates"
        />
        <div class="mt-3">
          <CompareCandidateTable
            :rows="candidates"
            :selected-id="templateId"
            @select="onSelectTemplate"
          />
        </div>
      </Step>

      <!-- Step 2 — pick the two versions -->
      <Step :n="2" title="比較する2つの版を選ぶ" :active="!!templateId" :connector="false">
        <VersionPicker v-if="templateId" :versions="versions" @compare="onCompare" />
        <p v-else class="text-[13px] text-muted-foreground">
          ステップ1でテンプレートを選択してください。
        </p>
      </Step>
    </div>

    <p v-if="notEnoughVersions" class="text-sm text-muted-foreground">
      このテンプレートには比較できる版が足りません（確定保存が2回以上必要です）。
    </p>
    <p v-if="compareError" class="text-sm text-destructive">{{ compareError }}</p>

    <div v-if="rendering" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" /> 比較を生成中…
    </div>
  </div>
</template>
