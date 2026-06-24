<script setup lang="ts">
// =============================================================================
// CompareView.vue — ファイル比較画面のオーケストレータ(A/B選択 → 差分生成)
// =============================================================================
import { isErr, type TemplateMeta, type TemplateVersionMeta, toAppError } from '@editor/shared';
import { Info, Loader2 } from '@lucide/vue';
import { computed, ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import Step from '@/components/ui/Step.vue';
import { logError } from '@/lib/appError';
import { useAsyncResult } from '@/lib/useAsyncResult';
import CompareResultView from './CompareResultView.vue';
import CompareSideSelector from './CompareSideSelector.vue';
import { buildHtmlDiff, type HtmlDiff } from './htmlBlockDiff';
import { useCompareService } from './services/compareService';

const compare = useCompareService();
const { run } = useAsyncResult();

type Phase = 'select' | 'result';
const phase = ref<Phase>('select');

// 任意のテンプレ×版を A/B 独立に選択(別ファンド同士も可)。
type Side = { meta: TemplateMeta; version: TemplateVersionMeta } | null;
const sideA = ref<Side>(null);
const sideB = ref<Side>(null);
const canCompare = computed(() => !!sideA.value && !!sideB.value);

interface CompareResult {
  before: TemplateVersionMeta;
  after: TemplateVersionMeta;
  beforeFile: string;
  afterFile: string;
  diff: HtmlDiff;
  cssBefore: string;
  cssAfter: string;
}

const rendering = ref(false);
const compareError = ref<string | null>(null);
const result = ref<CompareResult | null>(null);

// A=ファイルA(左), B=ファイルB(右)。
async function onCompare() {
  const a = sideA.value;
  const b = sideB.value;
  if (!a || !b) return;
  compareError.value = null;
  rendering.value = true;
  try {
    const [ra, rb] = await Promise.all([
      run(() => compare.renderVersionHtml(a.version.historyId)),
      run(() => compare.renderVersionHtml(b.version.historyId)),
    ]);
    if (isErr(ra) || isErr(rb)) return; // toast は既に表示済みなので黙って返す
    result.value = {
      before: a.version,
      after: b.version,
      beforeFile: a.meta.fileName,
      afterFile: b.meta.fileName,
      diff: buildHtmlDiff(ra.value.html, rb.value.html, ra.value.css, rb.value.css),
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
    :before="result.before"
    :after="result.after"
    :before-file="result.beforeFile"
    :after-file="result.afterFile"
    :diff="result.diff"
    :css-before="result.cssBefore"
    :css-after="result.cssAfter"
    @back="back"
  />

  <div v-else class="space-y-4">
    <div>
      <h2 class="text-lg font-bold">ファイルの比較</h2>
      <p class="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Info class="h-3.5 w-3.5 shrink-0" />
        比較元と比較先を選んで比較します。別ファンド同士も比較できます。
      </p>
    </div>

    <div class="rounded-[14px] border bg-card px-6 pb-1 pt-6 shadow-sm">
      <Step :n="1" title="比較元を選ぶ" hint="委託会社・ファンド・版種で絞り込み、テンプレートと版を選択してください。" :active="!sideA" :done="!!sideA">
        <CompareSideSelector side="a" @change="sideA = $event" />
      </Step>
      <Step :n="2" title="比較先を選ぶ" hint="比較するもう一方を選択してください（別ファンドでも可）。" :active="!!sideA && !sideB" :done="!!sideB" :connector="false">
        <CompareSideSelector side="b" @change="sideB = $event" />
      </Step>
    </div>

    <div class="flex items-center gap-3">
      <Button :disabled="!canCompare || rendering" @click="onCompare">比較する</Button>
      <span v-if="!canCompare" class="text-[13px] text-muted-foreground">
        比較元・比較先それぞれでテンプレートと版を選択してください。
      </span>
      <span v-if="rendering" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" /> 比較を生成中…
      </span>
    </div>

    <p v-if="compareError" class="text-sm text-destructive">{{ compareError }}</p>
  </div>
</template>
